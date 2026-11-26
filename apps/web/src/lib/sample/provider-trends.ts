// A provider's percentile trends for the dev preview (lib/sample/answers.ts), like GET
// /api/providers/:provider/trends.
import type { Environment } from "../job-times";
import { DAY_MS } from "../job-times";
import { startOfDay } from "../time-zone";
import type { Percentiles, ProviderTrends } from "../provider-trends.ts";

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
