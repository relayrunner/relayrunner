import { drizzle } from "drizzle-orm/d1";
import { retryOverloadedReads } from "./retry.ts";
import * as schema from "./schema.ts";

export function createDb(d1: D1Database | D1DatabaseSession) {
  // Drizzle's D1 driver only calls prepare() and batch(), which a session has too.
  return drizzle(retryOverloadedReads(d1), { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };

/**
 * A Drizzle query as a raw D1 statement, for a `$client.batch` that also carries hand-written SQL,
 * which Drizzle's own batch can't.
 */
export function prepare(db: Db, query: { toSQL(): { sql: string; params: unknown[] } }) {
  const built = query.toSQL();
  return db.$client.prepare(built.sql).bind(...built.params);
}
