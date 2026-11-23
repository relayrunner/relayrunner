// The Router's outcomes for the dev preview (lib/sample/answers.ts), like GET
// /api/workspaces/:id/route-outcomes.
import { DAY_MS } from "../job-times";
import { startOfDay } from "../time-zone";
import { OUTCOME_DAYS, type OutcomeCounts, type RouteOutcomes } from "../route-outcomes.ts";

/** Dev preview: a made-up week, with a busy day when the machines filled up. */
export function sampleRouteOutcomes(now = Date.now()): RouteOutcomes {
  const from = startOfDay(now, 1 - OUTCOME_DAYS);
  const days: [number, number, number, number][] = [
    [148, 6, 0, 0],
    [161, 9, 1, 0],
    [40, 1, 0, 0],
    [36, 0, 0, 0],
    [172, 38, 6, 1],
    [158, 12, 2, 0],
    [94, 4, 0, 0],
  ];
  const buckets = days.map(([first, movedOn, waited, failed], i) => ({
    start: from + i * DAY_MS,
    first,
    movedOn,
    waited,
    failed,
  }));
  const counts: OutcomeCounts = { first: 0, movedOn: 0, waited: 0, failed: 0 };
  for (const day of buckets)
    for (const key of Object.keys(counts) as (keyof OutcomeCounts)[]) counts[key] += day[key];
  return {
    from,
    to: now,
    bucketMs: DAY_MS,
    runs: counts.first + counts.movedOn + counts.waited + counts.failed,
    ...counts,
    reasons: [
      { reason: "machines", count: 52 },
      { reason: "limit", count: 14 },
      { reason: "unhealthy", count: 4 },
    ],
    buckets,
  };
}
