import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card.ts";

/**
 * Operator alert from apps/api/src/health-issues.ts: background work that keeps failing, and work
 * that started working again. `lines` are the same ones Slack gets.
 */
export function renderHealthAlertEmail(ctx: { failing: number; lines: string[] }): RenderedEmail {
  const title = ctx.failing
    ? `${ctx.failing === 1 ? "1 thing keeps" : `${ctx.failing} things keep`} failing`
    : "Failing work is working again";
  const intro = ctx.failing
    ? "Background work or a workspace integration keeps failing. Check the API Worker's logs for the full errors."
    : "Background work that kept failing is working again.";
  return renderEmailCard({
    subject: `[health] ${title}`,
    preheader: intro,
    eyebrow: "Health",
    title,
    bodyHtml: `${escapeHtml(intro)}<br><br>${ctx.lines.map(escapeHtml).join("<br>")}`,
    text: [intro, "", ...ctx.lines].join("\n"),
    footNoteHtml: "Internal alert for RelayRunner operators.",
  });
}
