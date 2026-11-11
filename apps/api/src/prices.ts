// The price book reports price jobs with: the base list in @relayrunner/providers plus the rows
// operators record in provider_price, so a price change shows up without a deploy.
import {
  BASE_BOOK,
  BASE_PRICES,
  isRate,
  type PriceBook,
  priceBook,
  type PricedProvider,
} from "@relayrunner/providers";
import { asc } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";

// How long an isolate reuses the book it read. Operators' own changes clear it at once (see
// forgetPriceBook); another isolate picks them up within this.
const CACHE_MS = 60_000;

let cached: { book: PriceBook; until: number } | undefined;

/** The price rows operators recorded, oldest first. */
export function recordedPrices(db: Db) {
  return db.select().from(schema.providerPrice).orderBy(asc(schema.providerPrice.from));
}

/**
 * The base prices with the recorded rows on top. If D1 can't be read, the base list alone, so a
 * report still has prices.
 */
export async function loadPriceBook(db: Db, now = Date.now()): Promise<PriceBook> {
  if (cached && now < cached.until) return cached.book;
  try {
    const rows = await recordedPrices(db);
    const recorded = rows
      .filter((row) => isRate(row.provider, row.rate))
      .map((row) => ({ ...row, provider: row.provider as PricedProvider }));
    cached = { book: priceBook([...BASE_PRICES, ...recorded]), until: now + CACHE_MS };
    return cached.book;
  } catch (error) {
    console.error(JSON.stringify({ msg: "price rows unreadable", error: String(error) }));
    return BASE_BOOK;
  }
}

/** Drops this isolate's cached book, after a price row is added or removed. */
export function forgetPriceBook() {
  cached = undefined;
}
