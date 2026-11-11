import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card.ts";

/**
 * Operator alert from the daily price check (apps/api/src/price-check.ts): prices that changed on a
 * provider's page, waiting for approval, and pages that stopped reading.
 */
export function renderPriceCheckEmail(ctx: {
  /** Names and prices as shown, such as "Depot linux" and "$0.003/min". */
  changes: { name: string; price: string; from: string }[];
  failures: { name: string; error: string }[];
  pricesUrl: string;
}): RenderedEmail {
  const lines = [
    ...ctx.changes.map(({ name, price, from }) => `${name}: ${price} from ${from}`),
    ...ctx.failures.map(({ name, error }) => `${name}: couldn't read the price page (${error})`),
  ];
  const count = ctx.changes.length;
  const title = count
    ? `${count === 1 ? "1 price" : `${count} prices`} changed`
    : "A price page stopped reading";
  const intro = count
    ? "The daily price check found new prices. Jobs keep their current price until you approve them."
    : "The daily price check couldn't read a provider's price page, so changes there go unnoticed until it's fixed.";
  return renderEmailCard({
    subject: `[prices] ${title}`,
    preheader: intro,
    eyebrow: "Prices",
    title,
    bodyHtml: `${escapeHtml(intro)}<br><br>${lines.map(escapeHtml).join("<br>")}`,
    text: [intro, "", ...lines, "", `Review them: ${ctx.pricesUrl}`].join("\n"),
    cta: { url: ctx.pricesUrl, label: "Review prices →" },
    footNoteHtml: "Internal alert for RelayRunner operators.",
  });
}
