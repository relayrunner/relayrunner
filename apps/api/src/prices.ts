// The price book reports price jobs with: the base list in @relayrunner/providers plus the rows
// operators record in provider_price, so a price change shows up without a deploy.
import {
  BASE_BOOK,
  BASE_PRICES,
  type PriceBook,
  priceBook,
  type PricedProvider,
} from "@relayrunner/providers";
import { cachedRead } from "./d1-cache.ts";
import { type Db, schema } from "./db/index.ts";

const priceBookCache = cachedRead("price rows", readPriceBook, () => BASE_BOOK);

/** The base prices with the rows operators recorded on top, read from D1 now. */
export async function readPriceBook(db: Db): Promise<PriceBook> {
  const recorded = await db.select().from(schema.providerPrice);
  // priceBook drops rows for rates it doesn't know.
  return priceBook([
    ...BASE_PRICES,
    ...recorded.map((row) => ({ ...row, provider: row.provider as PricedProvider })),
  ]);
}

/** readPriceBook, cached per isolate; the base list alone if D1 can't be read (d1-cache.ts). */
export const loadPriceBook = priceBookCache.load;

/** Drops this isolate's cached book, after a price row is added or removed. */
export const forgetPriceBook = priceBookCache.forget;
