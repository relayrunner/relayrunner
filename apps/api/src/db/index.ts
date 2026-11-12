import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

/**
 * Wraps D1 in Drizzle. Pass `env.DB` to read and write on the primary, or a D1 session
 * (`env.DB.withSession(...)`) to let reads go to a nearby read replica.
 */
export function createDb(d1: D1Database | D1DatabaseSession) {
  // Drizzle's D1 driver only calls prepare() and batch(), which a session has too; its types just
  // don't list sessions yet.
  return drizzle(d1 as D1Database, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
