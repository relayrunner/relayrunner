import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card.ts";

/**
 * Feedback an agent sent through the MCP server's send_feedback tool (apps/api/src/feedback.ts),
 * for the team inbox. Every field is agent-written and already sanitized; it's escaped here too.
 */
export function renderAgentFeedbackEmail(ctx: {
  id: string;
  category: string;
  summary: string;
  details: string | null;
  tool: string | null;
  redacted: number;
  user: { name: string; email: string };
  workspaceName: string | null;
  clientName: string | null;
  sentAt: Date;
}): RenderedEmail {
  const rows: [string, string | null][] = [
    ["Category", ctx.category],
    ["From", `${ctx.user.name} <${ctx.user.email}>`],
    ["Agent", ctx.clientName ?? "unknown client"],
    ["Workspace", ctx.workspaceName ?? "none named"],
    ["Tool", ctx.tool],
    ["Sent", ctx.sentAt.toUTCString()],
    ["Id", ctx.id],
    ["Redacted", ctx.redacted ? `${ctx.redacted} secret-like value(s)` : null],
  ];
  const meta = rows.filter((row): row is [string, string] => row[1] !== null);
  const details = ctx.details ?? "(no details)";
  return renderEmailCard({
    subject: `[feedback] ${ctx.category}: ${ctx.summary}`,
    preheader: ctx.summary,
    eyebrow: "Agent feedback",
    title: ctx.summary,
    bodyHtml: [
      meta.map(([label, value]) => `${escapeHtml(label)}: ${strong(value)}`).join("<br>"),
      "<br><br>",
      `<div style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(details)}</div>`,
    ].join(""),
    text: [...meta.map(([label, value]) => `${label}: ${value}`), "", details].join("\n"),
    footNoteHtml: "Sent by an agent through the RelayRunner MCP server. Reply to reach the person.",
  });
}
