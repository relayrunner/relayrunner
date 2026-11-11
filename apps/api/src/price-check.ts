/**
 * The daily price check (a cron in wrangler.jsonc). Reads each provider's price page
 * (PRICE_SOURCES in @relayrunner/providers) and saves each price that differs from the one jobs
 * are priced at as a price_finding, for an operator to approve into provider_price or dismiss in
 * Admin → Prices. Nothing changes a report until then. Emails OPERATOR_ALERT_EMAIL when it finds
 * a change or a page stops reading.
 */
import {
  dayMs,
  type FoundPrice,
  isRate,
  PRICE_SOURCES,
  type PriceBook,
  type PriceSource,
} from "@relayrunner/providers";
import { createDb, schema } from "./db/index.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { readPriceBook } from "./prices.ts";
import { errorMessage } from "./webhook-queue.ts";

const FETCH_TIMEOUT_MS = 15_000;

type Finding = typeof schema.priceFinding.$inferSelect;

export interface PriceCheckResult {
  provider: string;
  /** Why the page couldn't be read, or null. */
  error: string | null;
  /** New findings saved this run. */
  found: Finding[];
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

async function read(source: PriceSource, fetcher: typeof fetch): Promise<FoundPrice[]> {
  const response = await fetcher(source.url, {
    headers: { "user-agent": "RelayRunner price check (+https://relayrunner.app)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return source.parse(await response.text());
}

/**
 * The prices on a page that differ from the book and weren't found before (pending or dismissed).
 * A dated price (Ubicloud lists its whole history) is checked on its own day, an undated one
 * against now.
 */
export function newFindings(
  source: PriceSource,
  prices: FoundPrice[],
  book: PriceBook,
  earlier: Finding[],
  now: Date,
): Finding[] {
  const { provider } = source;
  const today = now.toISOString().slice(0, 10);
  return prices.flatMap((price) => {
    if (!isRate(provider, price.rate)) return [];
    const current = book.usd(provider, price.rate, price.from ? dayMs(price.from) : now.getTime());
    if (current !== null && same(current, price.usd)) return [];
    const seen = earlier.some(
      (row) =>
        row.provider === provider &&
        row.rate === price.rate &&
        same(row.usd, price.usd) &&
        (!price.from || row.from === price.from),
    );
    if (seen) return [];
    return [
      {
        id: crypto.randomUUID(),
        provider,
        rate: price.rate,
        usd: price.usd,
        from: price.from ?? today,
        source: source.page,
        foundAt: now,
        dismissedAt: null,
      },
    ];
  });
}

/** Checks every price page, saves what changed, and emails operators about anything new. */
export async function checkPrices(
  env: Env,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<PriceCheckResult[]> {
  const db = createDb(env.DB);
  const [book, earlier, lastChecks] = await Promise.all([
    readPriceBook(db),
    db.select().from(schema.priceFinding),
    db.select().from(schema.priceCheck),
  ]);

  const results = await Promise.all(
    PRICE_SOURCES.map(async (source): Promise<PriceCheckResult> => {
      const { provider } = source;
      try {
        const prices = await read(source, fetcher);
        return { provider, error: null, found: newFindings(source, prices, book, earlier, now) };
      } catch (error) {
        return { provider, error: errorMessage(error), found: [] };
      }
    }),
  );

  const found = results.flatMap((result) => result.found);
  const [first, ...rest] = [
    ...results.map(({ provider, error }) =>
      db
        .insert(schema.priceCheck)
        .values({ provider, checkedAt: now, error })
        .onConflictDoUpdate({ target: schema.priceCheck.provider, set: { checkedAt: now, error } }),
    ),
    // A statement a row keeps each under D1's bound-parameter limit.
    ...found.map((finding) => db.insert(schema.priceFinding).values(finding)),
  ];
  await db.batch([first!, ...rest]);

  // A page that stops reading is news once; it shows on the admin page until it reads again.
  const failures = results.filter(
    (result): result is PriceCheckResult & { error: string } =>
      result.error !== null &&
      !lastChecks.some((check) => check.provider === result.provider && check.error),
  );
  console.log(
    JSON.stringify({
      msg: "price check",
      found: found.length,
      failed: results.filter((r) => r.error).map(({ provider, error }) => ({ provider, error })),
    }),
  );
  if (env.OPERATOR_ALERT_EMAIL && (found.length || failures.length)) {
    await sendEmail(env, {
      to: env.OPERATOR_ALERT_EMAIL,
      template: "price-check",
      context: { changes: found, failures },
    });
  }
  return results;
}
