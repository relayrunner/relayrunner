// A provider page's charts (GET /api/providers/:provider/trends): for its busiest runner types, how
// long jobs waited and ran at P50 to P99, and how many the runner gave up on, a day at a time.
import type { Environment } from "@/lib/job-times";
import { api } from "@/lib/api";
import { DAY_MS } from "@/lib/job-times";
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

/** Dev preview: made-up days for the sample runners, with a slow patch mid-range. */
export function sampleProviderTrends(
  runners: (Environment & { jobs: number })[],
  days: number,
  now = Date.now(),
): ProviderTrends {
  const bucketMs = days > 31 ? 7 * DAY_MS : DAY_MS;
  const count = Math.max(1, Math.ceil((days * DAY_MS) / bucketMs));
  const origin = startOfDay(now - (count - 1) * bucketMs);
  const spread = (base: number): Percentiles => ({
    p50: base,
    p75: base * 1.5,
    p90: base * 2.4,
    p95: base * 3.4,
    p99: base * 6,
  });
  return {
    bucketMs,
    runners: runners.slice(0, 6).map((runner, r) => ({
      ...runner,
      points: Array.from({ length: count }, (_, i) => {
        const start = origin + i * bucketMs;
        const weekday = new Date(start).getDay();
        const jobs = Math.round(
          (runner.jobs / count) *
            (bucketMs === DAY_MS && (weekday === 0 || weekday === 6) ? 0.3 : 1),
        );
        // A busy stretch a third of the way in.
        const busy = Math.abs(i - Math.round(count / 3)) <= 1 ? 3 : 1;
        const wobble = 0.8 + 0.4 * Math.abs(Math.sin((i + 1) * (r + 2)));
        return {
          start,
          jobs,
          runnerFailures: busy > 1 && r === 0 ? Math.ceil(jobs * 0.04) : i % 5 === r ? 1 : 0,
          wait: jobs >= 3 ? spread(Math.round((4_000 + r * 3_000) * busy * wobble)) : null,
          run: jobs >= 3 ? spread(Math.round((150_000 + r * 60_000) * wobble)) : null,
        };
      }),
    })),
  };
}
