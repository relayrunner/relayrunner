// Reads of operator-edited D1 rows that every report needs (prices, providers), reused per isolate
// so a busy report doesn't read them on every request.
import type { Db } from "./db/index.ts";
import { log } from "./log.ts";

// How long an isolate reuses what it read. Operators' own changes clear it at once (forget);
// another isolate picks them up within this.
const CACHE_MS = 60_000;

/**
 * `read`, reused for CACHE_MS per isolate. If D1 can't be read, `fallback` (the list in code), so
 * a report still works, and the next call tries D1 again.
 */
export function cachedRead<T>(name: string, read: (db: Db) => Promise<T>, fallback: () => T) {
  // Only a value already read is shared. A read still in flight belongs to the request that
  // started it: if that request ends first, another request awaiting it would fail.
  let cached: { value: T; until: number } | undefined;
  return {
    async load(db: Db, now = Date.now()): Promise<T> {
      if (cached && now < cached.until) return cached.value;
      try {
        const value = await read(db);
        cached = { value, until: now + CACHE_MS };
        return value;
      } catch (error) {
        log.warn("d1_cache.unreadable", `${name} unreadable`, { cache: name, error });
        return fallback();
      }
    },
    /** Drops this isolate's cached value, after an operator changes the rows. */
    forget() {
      cached = undefined;
    },
  };
}
