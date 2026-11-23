import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card.ts";

/**
 * Feedback for the team inbox, from a person in the dashboard, an agent through the MCP server's
 * send_feedback tool, or a machine through `relayrunner feedback`, which RelayRunner for Mac uses for
 * crash reports (apps/api/src/routes/feedback.ts). Every field is user- or agent-written and
 * already sanitized; it's escaped here too.
 */
export function renderFeedbackEmail(ctx: {
  id: string;
  /** Agents pick one; a person's message has none. */
  category: string | null;
  summary: string;
  details?: string | null;
  tool?: string | null;
  page?: string | null;
  redacted: number;
  user: { name: string; email: string };
  workspaceName: string | null;
  /** The agent that sent it, when one did. */
  agent: { name: string | null } | null;
  /** The machine that sent it, when one did. */
  machine?: { name: string; macAppVersion: string | null } | null;
  sentAt: Date;
}): RenderedEmail {
  const rows: [string, string | null | undefined][] = [
    ["Category", ctx.category],
    ["From", `${ctx.user.name} <${ctx.user.email}>`],
    ["Agent", ctx.agent && (ctx.agent.name ?? "unknown client")],
    [
      "Machine",
      ctx.machine &&
        `${ctx.machine.name}${ctx.machine.macAppVersion ? ` (Mac app ${ctx.machine.macAppVersion})` : ""}`,
    ],
    ["Workspace", ctx.workspaceName ?? "none named"],
    ["Page", ctx.page],
    ["Tool", ctx.tool],
    ["Sent", ctx.sentAt.toUTCString()],
    ["Id", ctx.id],
    ["Redacted", ctx.redacted ? `${ctx.redacted} secret-like value(s)` : null],
  ];
  const meta = rows.filter((row): row is [string, string] => row[1] != null);
  const details = ctx.details ?? "(no details)";
  return renderEmailCard({
    subject: `[feedback] ${ctx.category ? `${ctx.category}: ` : ""}${ctx.summary}`,
    preheader: ctx.summary,
    eyebrow: ctx.agent ? "Agent feedback" : ctx.machine ? "Machine feedback" : "Feedback",
    title: ctx.summary,
    bodyHtml: [
      meta.map(([label, value]) => `${escapeHtml(label)}: ${strong(value)}`).join("<br>"),
      "<br><br>",
      `<div style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(details)}</div>`,
    ].join(""),
    text: [...meta.map(([label, value]) => `${label}: ${value}`), "", details].join("\n"),
    footNoteHtml: `Sent ${sentFrom(ctx)}. Reply to reach the person.`,
  });
}

function sentFrom(ctx: { agent: unknown; machine?: { macAppVersion: string | null } | null }) {
  if (ctx.agent) return "by an agent through the RelayRunner MCP server";
  if (ctx.machine?.macAppVersion) return "from RelayRunner for Mac";
  if (ctx.machine) return "with relayrunner feedback";
  return "from the RelayRunner dashboard";
}
