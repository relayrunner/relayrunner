/**
 * Outbound transactional email through Cloudflare Email Sending (the EMAIL send_email binding).
 * Templates live in @relayrunner/email; this module only sends. Like ~/Code/uploads'
 * apps/auth/src/email.ts it never throws: a missing binding (local dev, tests) or a failed send
 * only logs, so a sign-in, a machine claim or the hourly cron never fails because of mail.
 */
import {
  renderFeedbackEmail,
  renderDeadLetterAlertEmail,
  renderMachineConnectedEmail,
  renderMachineTakenOverEmail,
  renderPriceCheckEmail,
  renderWelcomeEmail,
  type ConnectionPlace,
  type RenderedEmail,
} from "@relayrunner/email";
import { providerName, rateText } from "@relayrunner/providers";
import type { Env } from "./env.ts";
import { createDb } from "./db/index.ts";
import type { DistributiveOmit } from "./machines.ts";
import { isNotificationType, operatorRecipients, wantsEmail } from "./notifications.ts";

// send.relayrunner.app is the domain onboarded for Email Sending. Keep EMAIL_FROM inside the
// binding's allowed_sender_addresses in wrangler.jsonc.
export const DEFAULT_FROM = "noreply@send.relayrunner.app";

export type EmailArgs = (
  | { to: string; template: "welcome"; context: { name?: string } }
  | {
      to: string;
      template: "machine-connected";
      context: {
        machineName: string;
        os?: string | null;
        arch?: string | null;
        workspaceNames: string[];
        connectedAt: Date;
      };
    }
  | {
      to: string;
      template: "machine-taken-over";
      context: {
        machineName: string;
        was: ConnectionPlace;
        now: ConnectionPlace;
        at: Date;
      };
    }
  | { to: string; template: "dead-letter-alert"; context: { count: number; threshold: number } }
  | {
      to: string;
      template: "price-check";
      context: {
        changes: { provider: string; rate: string; usd: number; from: string }[];
        failures: { provider: string; error: string }[];
      };
    }
  | {
      to: string;
      template: "feedback";
      context: Parameters<typeof renderFeedbackEmail>[0];
    }
) & {
  replyTo?: string;
  /** The recipient's user id. Set it and the email skips anyone who turned this type off. */
  userId?: string;
};

/** Where links in emails point: the dashboard people actually use, not the OAuth callback host. */
export function dashboardUrl(env: Pick<Env, "DASHBOARD_URL" | "BETTER_AUTH_URL">) {
  return (env.DASHBOARD_URL || env.BETTER_AUTH_URL).replace(/\/$/, "");
}

function render(env: Env, args: EmailArgs): RenderedEmail {
  const dashboard = dashboardUrl(env);
  switch (args.template) {
    case "welcome":
      return renderWelcomeEmail({ ...args.context, dashboardUrl: dashboard });
    case "machine-connected":
      return renderMachineConnectedEmail({
        ...args.context,
        machinesUrl: `${dashboard}/runners`,
        settingsUrl: `${dashboard}/settings/notifications`,
      });
    case "machine-taken-over":
      return renderMachineTakenOverEmail({ ...args.context, machinesUrl: `${dashboard}/runners` });
    case "dead-letter-alert":
      return renderDeadLetterAlertEmail({
        ...args.context,
        inspectorUrl: `${dashboard}/admin/webhooks`,
      });
    case "price-check":
      return renderPriceCheckEmail({
        changes: args.context.changes.map(({ provider, rate, usd, from }) => ({
          name: `${providerName(provider)} ${rate}`,
          price: rateText(usd),
          from,
        })),
        failures: args.context.failures.map(({ provider, error }) => ({
          name: providerName(provider),
          error,
        })),
        pricesUrl: `${dashboard}/admin/prices`,
      });
    case "feedback":
      return renderFeedbackEmail(args.context);
  }
}

export async function sendEmail(env: Env, args: EmailArgs): Promise<void> {
  if (args.userId && isNotificationType(args.template)) {
    // If the setting can't be read, send: a missed notice is worse than an unwanted one.
    const wanted = await wantsEmail(createDb(env.DB), args.userId, args.template).catch(() => true);
    if (!wanted) return;
  }
  let rendered: RenderedEmail;
  try {
    rendered = render(env, args);
  } catch (error) {
    console.error(
      JSON.stringify({ msg: "email not rendered", template: args.template, error: message(error) }),
    );
    return;
  }
  if (!env.EMAIL) {
    console.warn(
      JSON.stringify({ msg: "email not sent: no EMAIL binding", template: args.template }),
    );
    return;
  }
  try {
    const { subject, text, html } = rendered;
    await env.EMAIL.send({
      to: args.to,
      from: { name: "RelayRunner", email: env.EMAIL_FROM || DEFAULT_FROM },
      ...(args.replyTo && { replyTo: args.replyTo }),
      subject,
      text,
      html,
    });
    console.log(JSON.stringify({ msg: "email sent", template: args.template }));
  } catch (error) {
    console.error(
      JSON.stringify({ msg: "email send failed", template: args.template, error: message(error) }),
    );
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type OperatorEmail = Extract<
  EmailArgs,
  { template: "feedback" | "dead-letter-alert" | "price-check" }
>;

/**
 * Sends an operator alert to the team inbox (FEEDBACK_EMAIL for feedback, else
 * OPERATOR_ALERT_EMAIL) and to each operator who asked for their own copy. Never throws.
 */
export async function emailOperators(env: Env, args: DistributiveOmit<OperatorEmail, "to">) {
  if (!env.EMAIL) {
    console.warn(
      JSON.stringify({ msg: "email not sent: no EMAIL binding", template: args.template }),
    );
    return;
  }
  const inbox = args.template === "feedback" ? env.FEEDBACK_EMAIL : env.OPERATOR_ALERT_EMAIL;
  const recipients = new Set(inbox ? [inbox] : []);
  try {
    for (const to of await operatorRecipients(createDb(env.DB), args.template)) recipients.add(to);
  } catch (error) {
    console.error(
      JSON.stringify({ msg: "operators not read", template: args.template, error: message(error) }),
    );
  }
  await Promise.all([...recipients].map((to) => sendEmail(env, { ...args, to } as EmailArgs)));
}
