// Reads of operator-edited D1 rows that every report needs (prices, providers), reused per isolate
// so a busy report doesn't read them on every request.
import type { Db } from "./db/index.ts";

// How long an isolate reuses what it read. Operators' own changes clear it at once (forget);
// another isolate picks them up within this.
const CACHE_MS = 60_000;

/**
 * `read`, reused for CACHE_MS per isolate. If D1 can't be read, `fallback` (the list in code), so
 * a report still works, and the next call tries D1 again.
 */
export function cachedRead<T>(name: string, read: (db: Db) => Promise<T>, fallback: () => T) {
  let cached: { value: Promise<T>; until: number } | undefined;
  return {
    load(db: Db, now = Date.now()): Promise<T> {
      if (!cached || now >= cached.until) {
        const value = read(db).catch((error: unknown) => {
          console.error(JSON.stringify({ msg: `${name} unreadable`, error: String(error) }));
          cached = undefined;
          return fallback();
        });
        cached = { value, until: now + CACHE_MS };
      }
      return cached.value;
    },
    /** Drops this isolate's cached value, after an operator changes the rows. */
    forget() {
      cached = undefined;
    },
  };
}
