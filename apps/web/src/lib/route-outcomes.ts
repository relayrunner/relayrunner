// The Router page's routing outcomes (GET /api/workspaces/:id/route-outcomes): how the Router
// placed the workspace's runs over the last week, a day at a time.
import type { MoveReason } from "@relayrunner/activity";
import { api } from "@/lib/api";
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
