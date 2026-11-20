import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card.ts";

/** A workspace integration that stopped working (apps/api/src/integration-issues.ts). */
export type WorkspaceProblem =
  | { kind: "app-suspended"; account: string; settingsUrl: string }
  | { kind: "billing-refused" }
  | { kind: "provider-token"; provider: string }
  | { kind: "telemetry-paused" }
  | { kind: "log-bucket-paused" };

/** To a workspace's owners and admins when one of its integrations stops working. */
export function renderIntegrationProblemEmail(
  ctx: WorkspaceProblem & { workspace: string; providerName: string; dashboardUrl: string },
): RenderedEmail {
  const { title, body, url, label } = copy(ctx);
  return renderEmailCard({
    subject: `${title} (${ctx.workspace})`,
    preheader: body,
    eyebrow: ctx.workspace,
    title,
    bodyHtml: escapeHtml(body),
    text: [body, "", `${label}: ${url}`].join("\n"),
    cta: { url, label: `${label} →` },
    footNoteHtml: `You're an owner or admin of ${escapeHtml(ctx.workspace)} on RelayRunner. Turn these emails off in Account settings › Email.`,
  });
}

function copy(ctx: Parameters<typeof renderIntegrationProblemEmail>[0]) {
  const dashboard = ctx.dashboardUrl;
  switch (ctx.kind) {
    case "app-suspended":
      return {
        title: "The RelayRunner app is suspended on GitHub",
        body: `Someone suspended the RelayRunner GitHub App on ${ctx.account}. Until it's unsuspended, jobs aren't routed and CI history stops updating.`,
        url: ctx.settingsUrl,
        label: "Open the app on GitHub",
      };
    case "billing-refused":
      return {
        title: "GitHub refused RelayRunner's billing reads",
        body: "RelayRunner can't read this account's Actions usage from GitHub, so spend on Usage is an estimate. Grant billing access to see what GitHub actually charged.",
        url: `${dashboard}/settings/github`,
        label: "Fix billing access",
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
