// The Router page's routing outcomes (GET /api/workspaces/:id/route-outcomes): how the Router
// placed the workspace's runs over the last week, a day at a time.
import type { MoveReason } from "@relayrunner/activity";
import { api } from "@/lib/api";
import { DAY_MS } from "@/lib/job-times";
import { startOfDay } from "@/lib/time-zone";

export type { MoveReason };

export type OutcomeCounts = {
  /** Runs that took the first step that fits them. */
  first: number;
  /** Runs that went further down the order because a step that fits them couldn't take them. */
  movedOn: number;
  /** Runs that queued for a slot on a full machine. */
  waited: number;
  /** Runs nothing in the order could take. */
  failed: number;
};

export type OutcomeBucket = OutcomeCounts & { start: number };

export type RouteOutcomes = OutcomeCounts & {
  from: number;
  to: number;
  bucketMs: number;
  runs: number;
  /** Why runs moved on, most first. */
  reasons: { reason: MoveReason; count: number }[];
  buckets: OutcomeBucket[];
};

export const OUTCOME_DAYS = 7;

/** The last OUTCOME_DAYS days, today included, from the reader's midnight. */
export function getRouteOutcomes(workspaceId: string, now = Date.now()) {
  const from = startOfDay(now, 1 - OUTCOME_DAYS);
  return api<RouteOutcomes>(
    `/workspaces/${encodeURIComponent(workspaceId)}/route-outcomes?from=${from}&to=${now}&origin=${from}`,
  );
}

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
