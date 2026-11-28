import { interpolate } from "@relayrunner/api-types";

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

/** The middle and spread of the values around one point. */
type Spread = { p10: number; median: number; p90: number };

/** How many neighbours a rolling median takes in: about a tenth of the runs, odd, from 5 to 21. */
export function rollingWindow(count: number) {
  const size = Math.min(Math.max(Math.round(count / 10), 5), 21);
  return Math.min(size % 2 ? size : size + 1, count);
}

/**
 * The median, 10th and 90th percentile of the `window` values around each one, in order. Near
 * either end the window slides inward rather than shrinking, so the line doesn't jump there.
 */
export function rollingSpreads(values: number[], window = rollingWindow(values.length)): Spread[] {
  const size = Math.min(Math.max(window, 1), values.length);
  const half = Math.floor(size / 2);
  return values.map((_, index) => {
    const from = Math.min(Math.max(index - half, 0), values.length - size);
    const sorted = values.slice(from, from + size).sort((a, b) => a - b);
    return {
      p10: quantile(sorted, 0.1),
      median: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
    };
  });
}

/**
 * Where a run of times, oldest first, moves into a new period: the index of each time whose
 * `periodOf` differs from the one before, starting with 0.
 */
export function periodStarts(times: number[], periodOf: (at: number) => number) {
  const starts: number[] = [];
  let last: number | undefined;
  times.forEach((at, index) => {
    const period = periodOf(at);
    if (period !== last) starts.push(index);
    last = period;
  });
  return starts;
}

export { interpolate };

/** interpolate, rounded to a whole number, for milliseconds. */
export const quantile = (sorted: number[], q: number) => Math.round(interpolate(sorted, q));
