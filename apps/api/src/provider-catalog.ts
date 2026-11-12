// The provider list reports and the dashboard use: the code list in @relayrunner/providers with
// the rows operators save in the admin (the provider table) on top, so a change shows up with no
// deploy. Read like the price book (prices.ts): cached per isolate, the code list alone if D1 can't
// be read.
import {
  BASE_CATALOG,
  type CatalogProvider,
  providerCatalog,
  type ProviderRow,
} from "@relayrunner/providers/catalog";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app.ts";
import { createDb, type Db, schema } from "./db/index.ts";

// How long an isolate reuses the list it read. Operators' own changes clear it at once (see
// forgetCatalog); another isolate picks them up within this.
const CACHE_MS = 60_000;

let cached: { catalog: Promise<CatalogProvider[]>; until: number } | undefined;
// The last list read, by id and the added ones alone, for code that works out a job's environment
// synchronously (job-times.ts).
let byId = new Map(BASE_CATALOG.map((p) => [p.id, p]));
let added: CatalogProvider[] = [];

function remember(catalog: CatalogProvider[]) {
  byId = new Map(catalog.map((p) => [p.id, p]));
  added = catalog.filter((p) => !p.builtIn);
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

/** readCatalog, reused for CACHE_MS per isolate. If D1 can't be read, the code list alone. */
export async function loadCatalog(db: Db, now = Date.now()): Promise<CatalogProvider[]> {
  if (!cached || now >= cached.until) {
    const catalog = readCatalog(db).catch((error: unknown) => {
      console.error(JSON.stringify({ msg: "provider rows unreadable", error: String(error) }));
      cached = undefined;
      return remember(BASE_CATALOG);
    });
    cached = { catalog, until: now + CACHE_MS };
  }
  return cached.catalog;
}

/**
 * Loads the list before a route that works out jobs' providers (environmentFor reads it
 * synchronously): Job times, Runs and the provider pages.
 */
export const withCatalog = createMiddleware<AppEnv>(async (c, next) => {
  await loadCatalog(createDb(c.env.DB));
  await next();
});

/** The providers operators added, from the list last loaded in this isolate. */
export const addedProviders = () => added;

/** Drops this isolate's cached list, after an operator saves or removes a provider. */
export function forgetCatalog() {
  cached = undefined;
}

/** Whether `id` is a provider in the current list, including ones operators added. */
export const isCatalogProvider = (id: string) => byId.has(id);

/** A provider's name in the current list, or the id when it isn't one. */
export const catalogName = (id: string) => byId.get(id)?.name ?? id;
