/**
 * The daily price check (a cron in wrangler.jsonc). Reads each provider's price page
 * (PRICE_SOURCES in @relayrunner/providers), or the price file the provider publishes when an
 * operator set one in Admin › Providers, and finds each price that differs from the one jobs are
 * priced at. A change from a provider's own file applies at once when it passes autoApplies; any
 * other change is saved as a price_finding, for an operator to approve into provider_price or
 * dismiss in Admin → Prices. Emails OPERATOR_ALERT_EMAIL and operators who opted in when it finds a
 * change or a page stops reading.
 */
import {
  dayMs,
  dayOf,
  type FoundPrice,
  isRate,
  PRICE_SOURCES,
  type PriceBook,
  priceFileSource,
  type PriceSource,
} from "@relayrunner/providers";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import { emailOperators } from "../email.ts";
import type { Env } from "../env.ts";
import { forgetPriceBook, readPriceBook } from "./prices.ts";
import { loadCatalog } from "./provider-catalog.ts";
import { errorMessage } from "../errors.ts";
import { log } from "../log.ts";

const FETCH_TIMEOUT_MS = 15_000;

type Finding = typeof schema.priceFinding.$inferSelect;

export interface PriceCheckResult {
  provider: string;
  /** Why the page couldn't be read, or null. */
  error: string | null;
  /** New findings saved this run. */
  found: Finding[];
  /** Changes from the provider's own price file that applied without an operator. */
  applied: Finding[];
}

/** Who a price row from a provider's price file is recorded as created by. */
const PRICE_FILE_AUTHOR = "price file";

// How far a provider's own file can move a price before an operator has to look: catches a typo
// like a missing zero, not a real price change.
const MAX_STEP = 2;

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

async function read(source: PriceSource, fetcher: typeof fetch): Promise<FoundPrice[]> {
  const response = await fetcher(source.url, {
    headers: { "user-agent": "RelayRunner price check (+https://relayrunner.dev)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return source.parse(await response.text());
}

/** A price that differs from the book, with what jobs are priced at on its day now. */
interface Change {
  finding: Finding;
  current: number | null;
}

/**
 * The prices on a page that differ from the book and weren't found before (pending or dismissed).
 * A dated price (Ubicloud lists its whole history) is checked on its own day, an undated one
 * against now.
 */
function newFindings(
  source: PriceSource,
  prices: FoundPrice[],
  book: PriceBook,
  earlier: Finding[],
  now: Date,
): Change[] {
  const { provider } = source;
  const today = dayOf(now);
  return prices.flatMap((price): Change[] => {
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
    const finding = {
      id: crypto.randomUUID(),
      provider,
      rate: price.rate,
      usd: price.usd,
      from: price.from ?? today,
      source: source.page,
      foundAt: now,
      dismissedAt: null,
    };
    return [{ finding, current }];
  });
}

/**
 * Whether a change from a provider's own price file applies without an operator: it starts today or
 * later, so no job already priced changes, and it moves the price by less than MAX_STEP either way.
 * A first price for a rate that has none applies too.
 */
function autoApplies({ finding, current }: Change, today: string): boolean {
  if (finding.from < today) return false;
  if (current === null) return true;
  const step = finding.usd / current;
  return step <= MAX_STEP && step >= 1 / MAX_STEP;
}

/**
 * What the check reads: each provider's price file where an operator set one, which takes the place
 * of the page RelayRunner reads for it otherwise, then the pages for every other provider.
 */
function priceSources(files: { id: string; priceUrl?: string }[]): PriceSource[] {
  const fromFiles = files.flatMap(({ id, priceUrl }) =>
    priceUrl ? [priceFileSource(id, priceUrl)] : [],
  );
  const withFile = new Set(fromFiles.map((source) => source.provider));
  return [...fromFiles, ...PRICE_SOURCES.filter((source) => !withFile.has(source.provider))];
}

/** Checks every price page, saves what changed, and emails operators about anything new. */
export async function checkPrices(
  env: Env,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<PriceCheckResult[]> {
  const db = createDb(env.DB);
  const [book, earlier, lastChecks, catalog] = await Promise.all([
    readPriceBook(db),
    db.select().from(schema.priceFinding),
    db.select().from(schema.priceCheck),
    loadCatalog(db),
  ]);
  const today = dayOf(now);

  const results = await Promise.all(
    priceSources(catalog).map(async (source): Promise<PriceCheckResult> => {
      const { provider } = source;
      try {
        const prices = await read(source, fetcher);
        const result: PriceCheckResult = { provider, error: null, found: [], applied: [] };
        for (const change of newFindings(source, prices, book, earlier, now)) {
          const auto = source.fromProvider && autoApplies(change, today);
          (auto ? result.applied : result.found).push(change.finding);
        }
        return result;
      } catch (error) {
        return { provider, error: errorMessage(error), found: [], applied: [] };
      }
    }),
  );

  const found = results.flatMap((result) => result.found);
  const applied = results.flatMap((result) => result.applied);
  const [first, ...rest] = [
    ...results.map(({ provider, error }) =>
      db
        .insert(schema.priceCheck)
        .values({ provider, checkedAt: now, error })
        .onConflictDoUpdate({ target: schema.priceCheck.provider, set: { checkedAt: now, error } }),
    ),
    // A statement a row keeps each under D1's bound-parameter limit.
    ...found.map((finding) => db.insert(schema.priceFinding).values(finding)),
    // A provider can change a price its file set for a day still to come, so its newest one wins.
    // A row an operator recorded for that day stays.
    ...applied.map(({ id, provider, rate, usd, from, source }) =>
      db
        .insert(schema.providerPrice)
        .values({ id, provider, rate, usd, from, source, createdBy: PRICE_FILE_AUTHOR })
        .onConflictDoUpdate({
          target: [
            schema.providerPrice.provider,
            schema.providerPrice.rate,
            schema.providerPrice.from,
          ],
          set: { usd, source, createdAt: now },
          setWhere: eq(schema.providerPrice.createdBy, PRICE_FILE_AUTHOR),
        }),
    ),
  ];
  await db.batch([first!, ...rest]);
  if (applied.length) forgetPriceBook();

  // A page that stops reading is news once; it shows on the admin page until it reads again.
  const failures = results.filter(
    (result): result is PriceCheckResult & { error: string } =>
      result.error !== null &&
      !lastChecks.some((check) => check.provider === result.provider && check.error),
  );
  log.info("provider.price_check", "price check", {
    found: found.length,
    applied: applied.map(({ provider, rate, usd, from }) => ({ provider, rate, usd, from })),
    failed: results.filter((r) => r.error).map(({ provider, error }) => ({ provider, error })),
  });
  if (found.length || applied.length || failures.length) {
    await emailOperators(env, {
      template: "price-check",
      context: { changes: found, applied, failures },
    });
  }
  return results;
}
