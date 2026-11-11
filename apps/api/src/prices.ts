// The price book reports price jobs with: the base list in @relayrunner/providers plus the rows
// operators record in provider_price, so a price change shows up without a deploy.
import {
  BASE_BOOK,
  BASE_PRICES,
  type PriceBook,
  priceBook,
  type PricedProvider,
} from "@relayrunner/providers";
import { type Db, schema } from "./db/index.ts";

// How long an isolate reuses the book it read. Operators' own changes clear it at once (see
// forgetPriceBook); another isolate picks them up within this.
const CACHE_MS = 60_000;

let cached: { book: Promise<PriceBook>; until: number } | undefined;

/** The base prices with the rows operators recorded on top, read from D1 now. */
export async function readPriceBook(db: Db): Promise<PriceBook> {
  const recorded = await db.select().from(schema.providerPrice);
  // priceBook drops rows for rates it doesn't know.
  return priceBook([
    ...BASE_PRICES,
    ...recorded.map((row) => ({ ...row, provider: row.provider as PricedProvider })),
  ]);
}

/**
 * readPriceBook, reused for CACHE_MS per isolate. If D1 can't be read, the base list alone, so a
 * report still has prices.
 */
export async function loadPriceBook(db: Db, now = Date.now()): Promise<PriceBook> {
  if (!cached || now >= cached.until) {
    const book = readPriceBook(db).catch((error: unknown) => {
      console.error(JSON.stringify({ msg: "price rows unreadable", error: String(error) }));
      cached = undefined;
      return BASE_BOOK;
    });
    cached = { book, until: now + CACHE_MS };
  }
  return cached.book;
}

/** Drops this isolate's cached book, after a price row is added or removed. */
export function forgetPriceBook() {
  cached = undefined;
}
