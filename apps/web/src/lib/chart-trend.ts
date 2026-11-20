// How a chart's time axis and its trend line are worked out. Kept free of `@/` imports so tests
// can load it, like time-range.ts.
const HOUR_MS = 3_600_000;

/** Bar and trend widths a chart picks from, each a whole number of hours that divides a day. */
const BUCKET_HOURS = [1, 2, 3, 4, 6, 12, 24];
/** About how many buckets a chart holds at most, so each stays wide enough to read. */
const MAX_BUCKETS = 48;
/** The shortest stretch a chart shows, so a few runs from the last hour still have room. */
const MIN_SPAN_MS = 6 * HOUR_MS;

/** The narrowest bucket that fits `spanMs` in about 48 of them, or a day. */
export function bucketMsFor(spanMs: number) {
  const hours = BUCKET_HOURS.find((each) => spanMs / (each * HOUR_MS) <= MAX_BUCKETS) ?? 24;
  return hours * HOUR_MS;
}

/**
 * Where a chart starts: at its first point rather than the start of the range, so a week with runs
 * on two days isn't mostly empty. It shows at least six hours, and never more than the range.
 */
export function chartStart(
  { from, to }: { from: number; to: number },
  firstAt: number | undefined,
) {
  if (firstAt === undefined) return from;
  return Math.max(from, Math.min(firstAt, to - MIN_SPAN_MS));
}

/** Each group's name once, busiest first, then by name. */
export function groupsByCount(names: string[]) {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([name]) => name);
}

/**
 * Which of the `bucketMs` buckets from `start` to `end` holds `at`. Times past either end go in the
 * first or last, so every chart on the same frame puts a run in the same column.
 */
export function bucketIndex(at: number, start: number, end: number, bucketMs: number) {
  const last = Math.max(Math.ceil((end - start) / bucketMs) - 1, 0);
  return Math.min(Math.max(Math.floor((at - start) / bucketMs), 0), last);
}

/** The middle and spread of what finished in one bucket. */
export type Spread = { at: number; count: number; p10: number; median: number; p90: number };

/**
 * The median, 10th and 90th percentile of the values in each `bucketMs` from `start` to `end`.
 * Buckets with nothing in them are left out, so a line through them breaks there.
 */
export function spreads(
  values: { at: number; value: number }[],
  start: number,
  end: number,
  bucketMs: number,
): Spread[] {
  const buckets = new Map<number, number[]>();
  for (const { at, value } of values) {
    const index = bucketIndex(at, start, end, bucketMs);
    const list = buckets.get(index);
    if (list) list.push(value);
    else buckets.set(index, [value]);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([index, list]) => {
      list.sort((a, b) => a - b);
      return {
        at: start + index * bucketMs,
        count: list.length,
        p10: quantile(list, 0.1),
        median: quantile(list, 0.5),
        p90: quantile(list, 0.9),
      };
    });
}

/** The q-quantile (0 to 1) of ascending values, interpolated the way the API's job times are. */
function quantile(sorted: number[], q: number) {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo));
}
