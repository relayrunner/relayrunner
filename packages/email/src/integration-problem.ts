import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card.ts";

/** A workspace integration that stopped working (apps/api/src/operator/integration-issues.ts). */
export type WorkspaceProblem =
  | { kind: "app-suspended"; account: string; settingsUrl: string }
  | { kind: "provider-token"; providerName: string }
  | { kind: "telemetry-paused" }
  | { kind: "log-bucket-paused" };

/** To a workspace's owners and admins when one of its integrations stops working. */
export function renderIntegrationProblemEmail(
  ctx: WorkspaceProblem & { workspace: string; dashboardUrl: string; reminder?: boolean },
): RenderedEmail {
  const { title, body, url, label } = copy(ctx);
  return renderEmailCard({
    subject: `${ctx.reminder ? "Reminder: " : ""}${title} (${ctx.workspace})`,
    preheader: body,
    eyebrow: ctx.workspace,
    title,
    bodyHtml: escapeHtml(body),
    text: [body, "", `${label}: ${url}`].join("\n"),
    cta: { url, label: `${label} →` },
    footNoteHtml: `You're an owner or admin of ${escapeHtml(ctx.workspace)} on RelayRunner. While it stays broken we remind you at most twice. Turn these emails off in Account settings › Email.`,
  });
}

function copy(ctx: Parameters<typeof renderIntegrationProblemEmail>[0]) {
  const dashboard = ctx.dashboardUrl;
  switch (ctx.kind) {
    case "app-suspended":
      return {
        title: "RelayRunner is paused on GitHub",
        body: `Someone with access to ${ctx.account} paused the RelayRunner app in its GitHub settings (GitHub calls this "suspend"). Until it's turned back on, jobs aren't routed and CI history stops updating.`,
        url: ctx.settingsUrl,
        label: "Turn it back on in GitHub",
      };
    case "provider-token":
      return {
        title: `${ctx.providerName} rejected its API token`,
        body: `${ctx.providerName} refused the API token saved for this workspace, so its usage stopped syncing. Add a new token to pick up where it left off.`,
        url: `${dashboard}/settings/providers`,
        label: "Update the token",
      };
    case "telemetry-paused":
      return {
        title: "Your telemetry export paused",
        body: "Your OpenTelemetry endpoint refused every send for days, so RelayRunner paused the export. Fix the endpoint or its headers, then turn the export back on.",
        url: `${dashboard}/settings/telemetry`,
        label: "Open Telemetry settings",
      };
    case "log-bucket-paused":
      return {
        title: "Your log archive paused",
        body: "Your log bucket refused every upload for days, so RelayRunner paused the archive. Check the bucket and its keys, then turn it back on.",
        url: `${dashboard}/settings/telemetry`,
        label: "Open Telemetry settings",
      };
  }
}
