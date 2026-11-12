// The provider list reports and the dashboard use: the code list in @relayrunner/providers with
// the rows operators save in the admin (the provider table) on top, so a change shows up with no
// deploy. Cached per isolate like the price book (d1-cache.ts).
import {
  BASE_CATALOG,
  type CatalogProvider,
  providerCatalog,
  type ProviderRow,
} from "@relayrunner/providers/catalog";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app.ts";
import { cachedRead } from "./d1-cache.ts";
import { createDb, type Db, schema } from "./db/index.ts";

// The last list read, for code that works out a job's environment synchronously (job-times.ts).
let latest = BASE_CATALOG;
let ids = new Set(latest.map((p) => p.id));

function remember(catalog: CatalogProvider[]) {
  latest = catalog;
  ids = new Set(catalog.map((p) => p.id));
  return catalog;
}

const toRow = (row: typeof schema.provider.$inferSelect): ProviderRow => ({
  ...row,
  updatedAt: row.updatedAt.toISOString(),
});

/** Every provider, read from D1 now. */
export async function readCatalog(db: Db): Promise<CatalogProvider[]> {
  const rows = await db.select().from(schema.provider);
  return remember(providerCatalog(rows.map(toRow)));
}

const catalogCache = cachedRead("provider rows", readCatalog, () => remember(BASE_CATALOG));

/** readCatalog, cached per isolate; the code list alone if D1 can't be read (d1-cache.ts). */
export const loadCatalog = catalogCache.load;

/**
 * Loads the list before a route that works out jobs' providers (environmentFor reads it
 * synchronously): Job times, Runs and the provider pages.
 */
export const withCatalog = createMiddleware<AppEnv>(async (c, next) => {
  await loadCatalog(createDb(c.env.DB));
  await next();
});

/** The list last loaded in this isolate. */
export const currentProviders = () => latest;

/** Drops this isolate's cached list, after an operator saves or removes a provider. */
export const forgetCatalog = catalogCache.forget;

/** Whether `id` is a provider in the current list, including ones operators added. */
export const isCatalogProvider = (id: string) => ids.has(id);
