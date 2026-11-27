import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card.ts";

type Change = { name: string; price: string; from: string };

const changeLine = ({ name, price, from }: Change) => `${name}: ${price} from ${from}`;

/**
 * Operator alert from the daily price check (apps/api/src/providers/price-check.ts): prices that
 * changed on a provider's page, waiting for approval; prices a provider's own price file changed,
 * already applied; and pages that stopped reading.
 */
export function renderPriceCheckEmail(ctx: {
  /** Names and prices as shown, such as "Depot linux" and "$0.003/min". Waiting for approval. */
  changes: Change[];
  /** Changes from a provider's own price file that already apply. */
  applied: Change[];
  failures: { name: string; error: string }[];
  pricesUrl: string;
}): RenderedEmail {
  const { applied } = ctx;
  const failures = ctx.failures.map(
    ({ name, error }) => `${name}: couldn't read prices (${error})`,
  );
  const sections: string[][] = [];
  if (ctx.changes.length)
    sections.push([
      "Waiting for your approval. Jobs keep their current price until you approve these:",
      ...ctx.changes.map(changeLine),
    ]);
  if (applied.length)
    sections.push(["Applied from the providers' own price files:", ...applied.map(changeLine)]);
  if (failures.length) sections.push(failures);

  const count = ctx.changes.length + applied.length;
  const title = count
    ? `${count === 1 ? "1 price" : `${count} prices`} changed`
    : "A price page stopped reading";
  const intro = count
    ? "The daily price check found new prices."
    : "The daily price check couldn't read a provider's prices, so changes there go unnoticed until it's fixed.";
  return renderEmailCard({
    subject: `[prices] ${title}`,
    preheader: intro,
    eyebrow: "Prices",
    title,
    bodyHtml: [intro, ...sections.map((lines) => lines.map(escapeHtml).join("<br>"))].join(
      "<br><br>",
    ),
    text: [
      intro,
      ...sections.map((lines) => lines.join("\n")),
      `Review them: ${ctx.pricesUrl}`,
    ].join("\n\n"),
    cta: { url: ctx.pricesUrl, label: "Review prices →" },
    footNoteHtml: "Internal alert for RelayRunner operators.",
  });
}
