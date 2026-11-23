// A provider page's charts (GET /api/providers/:provider/trends): for its busiest runner types, how
// long jobs waited and ran at P50 to P99, and how many the runner gave up on, a day at a time.
import type { Environment } from "@/lib/job-times";
import { api } from "@/lib/api";
import { reportQuery, resolveRange, type TimeRange } from "@/lib/time-range";
import { startOfDay } from "@/lib/time-zone";
export const PERCENTILES = [50, 75, 90, 95, 99] as const;
export type Percentile = (typeof PERCENTILES)[number];
export const PERCENTILE_OPTIONS = PERCENTILES.map((p) => ({ value: p, label: `P${p}` }));

export const TREND_METRICS = [
  { value: "wait", label: "Queue wait" },
  { value: "run", label: "Job time" },
  { value: "failures", label: "Runner failures" },
] as const;
export type TrendMetric = (typeof TREND_METRICS)[number]["value"];
/** Milliseconds at each percentile, or null when the bar had too few jobs. */
export type Percentiles = Record<`p${Percentile}`, number> | null;

export type TrendPoint = {
  start: number;
  jobs: number;
  /** Failed jobs the runner gave up on before any step ran. */
  runnerFailures: number;
  /** Queued to started. */
  wait: Percentiles;
  /** Started to completed, successful jobs only. */
  run: Percentiles;
};

export type TrendRunner = Environment & { jobs: number; points: TrendPoint[] };

export type ProviderTrends = { bucketMs: number; runners: TrendRunner[] };

/** A day at a time from the reader's midnight (a week past a month), even for a rolling range. */
export function getProviderTrends(provider: string, range: TimeRange) {
  const origin = String(startOfDay(resolveRange(range).from));
  return api<ProviderTrends>(
    `/providers/${encodeURIComponent(provider)}/trends?${reportQuery(range, { origin })}`,
  );
}
