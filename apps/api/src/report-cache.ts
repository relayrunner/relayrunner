// Report reads kept for a while, so a page opened again (or paged through) doesn't read the same
// rows again. Two layers: this isolate's memory, then the data center's Cache API, which other
// isolates there share. Keys hold the workspace (or its SQL and values), and only requests that
// passed the workspace guard reach a report, so a key never hands one workspace's rows to another.
//
// Only what a past window holds is kept long: those rows no longer change (a job is in a window by
// when it finished). Reads that reach up to now are kept for minutes at most.
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "./db/index.ts";
import type { Window } from "./reports/report-window.ts";
import { sha256Hex } from "./machines/machines.ts";
import { log } from "./log.ts";

/** How long rows of a window that has ended are kept. */
export const SETTLED_MS = 60 * 60_000;
/** How long a list the dashboard pages through is kept. */
export const LIVE_MS = 30_000;

// Bump to drop everything cached when a cached shape changes.
const VERSION = 1;
const ORIGIN = "https://report-cache.relayrunner.internal";
// Memory holds small answers only; bigger ones stay in the Cache API, so an isolate's memory
// stays a few MB however big the workspaces it serves.
const MEMORY_MAX_ENTRIES = 200;
const MEMORY_MAX_BYTES = 64 * 1024;
// Not Recent (recent.ts): a value is shared only once read. A read in flight belongs to the
// request that started it, and another request awaiting it fails if that one ends first.
const memory = new Map<string, { value: unknown; until: number }>();

/** `read`, or what it returned under `key` in the last `ttlMs`. */
export async function cached<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
  // Without the Cache API (Node, in tests) nothing is kept, so a test that adds rows reads them.
  const edge = edgeCache();
  if (!edge) return read();
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && now < hit.until) return hit.value as T;
  memory.delete(key);

  const request = new Request(`${ORIGIN}/v${VERSION}/${await sha256Hex(key)}`);
  const response = await edge.match(request).catch(() => undefined);
  if (response) {
    const body = await response.text();
    const value = JSON.parse(body) as T;
    remember(key, value, Number(response.headers.get("x-until")) || now + ttlMs, body.length);
    return value;
  }

  const value = await read();
  const until = now + ttlMs;
  const body = JSON.stringify(value);
  remember(key, value, until, body.length);
  const headers = {
    "content-type": "application/json",
    "cache-control": `max-age=${Math.ceil(ttlMs / 1000)}`,
    "x-until": String(until),
  };
  // Not awaited: the answer doesn't wait on the copy.
  void edge
    .put(request, new Response(body, { headers }))
    .catch((error: unknown) =>
      log.warn("report_cache.put_failed", "report cache put failed", { error }),
    );
  return value;
}

/**
 * The rows `query` reads over `prior`, a window that has ended (a trend's), kept for SETTLED_MS.
 * The window moves to 10-minute marks first, so loads minutes apart ask for the same rows.
 */
export function cachedPrior<T>(db: Db, prior: Window, query: (window: Window) => SQL) {
  const built = query(settledWindow(prior));
  const { sql, params } = dialect.sqlToQuery(built);
  return cached(JSON.stringify([sql, params]), SETTLED_MS, () => db.all<T>(built));
}

const SETTLE_MS = 10 * 60_000;

/** `window` moved down to 10-minute marks (see cachedPrior). */
export function settledWindow({ from, to }: Window): Window {
  return { from: roundDown(from, SETTLE_MS), to: roundDown(to, SETTLE_MS) };
}

/** `at` moved down to a whole `stepMs`, for cache keys that loads a moment apart share. */
export const roundDown = (at: number, stepMs: number) => at - (at % stepMs);

const dialect = new SQLiteSyncDialect();

function remember(key: string, value: unknown, until: number, bytes: number) {
  if (bytes > MEMORY_MAX_BYTES) return;
  memory.set(key, { value, until });
  if (memory.size > MEMORY_MAX_ENTRIES) memory.delete(memory.keys().next().value!);
}

/** The Cache API in Workers; none under Node (tests). */
export function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default;
}

/** Drops this isolate's copies, for tests. */
export function forgetReportCache() {
  memory.clear();
}
