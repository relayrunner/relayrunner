import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card.ts";

/** Operator alert when GitHub webhook dead letters pile up (apps/api/src/ingest/dead-letter-alert.ts). */
export function renderDeadLetterAlertEmail(ctx: {
  count: number;
  threshold: number;
  inspectorUrl: string;
}): RenderedEmail {
  const deliveries = ctx.count === 1 ? "1 delivery" : `${ctx.count} deliveries`;
  const intro = `${deliveries} from GitHub were dead-lettered in the past hour (the alert fires at ${ctx.threshold}).`;
  return renderEmailCard({
    subject: `[webhooks] ${deliveries} dead-lettered in the past hour`,
    preheader: intro,
    eyebrow: "Webhooks",
    title: "Webhook dead letters are rising",
    bodyHtml: `${escapeHtml(intro)}<br><br>Inspect and replay them from the dead-letter inspector on a dashboard preview (behind Cloudflare Access).`,
    text: [
      intro,
      "",
      `Inspect and replay them (behind Cloudflare Access): ${ctx.inspectorUrl}`,
    ].join("\n"),
    cta: { url: ctx.inspectorUrl, label: "Open the inspector →" },
    footNoteHtml: "Internal alert for RelayRunner operators.",
  });
}
