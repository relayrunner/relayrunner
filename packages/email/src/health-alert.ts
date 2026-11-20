import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card.ts";

/**
 * Operator alert from apps/api/src/health-issues.ts: background work that keeps failing, and work
 * that started working again.
 */
export function renderHealthAlertEmail(ctx: {
  alerts: { key: string; state: "failing" | "cleared"; failures: number; error: string }[];
}): RenderedEmail {
  const failing = ctx.alerts.filter((alert) => alert.state === "failing");
  const lines = ctx.alerts.map((alert) =>
    alert.state === "cleared"
      ? `${alert.key}: working again`
      : `${alert.key}: failed ${alert.failures} times in a row (${alert.error})`,
  );
  const title = failing.length
    ? `${failing.length === 1 ? "1 task keeps" : `${failing.length} tasks keep`} failing`
    : "Failing tasks are working again";
  const intro = failing.length
    ? "Background work keeps failing. Check the API Worker's logs for the full errors."
    : "Background work that kept failing is working again.";
  return renderEmailCard({
    subject: `[health] ${title}`,
    preheader: intro,
    eyebrow: "Health",
    title,
    bodyHtml: `${escapeHtml(intro)}<br><br>${lines.map(escapeHtml).join("<br>")}`,
    text: [intro, "", ...lines].join("\n"),
    footNoteHtml: "Internal alert for RelayRunner operators.",
  });
}
