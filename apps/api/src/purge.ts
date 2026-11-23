// Batched deletes for the retention crons.
import { and, lt, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./db/index.ts";

// Rows deleted per statement, so one purge never runs long. The hourly cron catches up on the rest.
const PURGE_BATCH = 5_000;

/**
 * Deletes a table's rows whose `column` is before `cutoff` (and that match `where`), PURGE_BATCH
 * at a time and at most 10 batches a call. Returns how many rows went.
 */
export async function purgeBefore(
  db: Db,
  target: SQLiteTable,
  column: SQLiteColumn,
  cutoff: Date | number,
  where?: SQL,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < 10; i += 1) {
    const result = await db.run(sql`
      delete from ${target} where rowid in (
        select rowid from ${target} where ${and(lt(column, cutoff), where)} limit ${PURGE_BATCH})`);
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < PURGE_BATCH) break;
  }
  return deleted;
}
