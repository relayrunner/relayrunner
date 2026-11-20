// The Router page's routing outcomes: of the runs the Router picked a runner for in a window, how
// many took the first step that fit them, how many moved further down the order because a step
// that fits them couldn't take the run then (a busy machine, a spending limit, a runner type that
// stopped picking up jobs), how many queued for a machine, and how many found nowhere to go.
//
// Each route_decision row is one pick, which routes one job, so the counts are routed jobs (a run
// with several relay jobs counts each).
//
// Database cost: one statement, a range of route_decision_workspace_idx (the workspace, created in
// the window), grouped so repeated walks come back once.
import { MOVE_REASONS, type MoveReason, type SkipReason } from "@relayrunner/activity";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { type Buckets, bucketStarts, chartBuckets, type Window } from "./report-window.ts";

const table = schema.routeDecision;

export interface OutcomeCounts {
  /** Runs that took the first step that fits them. */
  first: number;
  /** Runs that went further down the order because a step that fits them couldn't take them. */
  movedOn: number;
  /** Runs that queued for a slot on a full machine. */
  waited: number;
  /** Runs nothing in the order could take. */
  failed: number;
}

export interface OutcomeBucket extends OutcomeCounts {
  /** Epoch ms. */
  start: number;
}

export interface RouteOutcomes extends OutcomeCounts {
  from: number;
  to: number;
  bucketMs: number;
  runs: number;
  /** Why runs moved on, most first. Each run counts once, for the first step it moved past. */
  reasons: { reason: MoveReason; count: number }[];
  buckets: OutcomeBucket[];
}

interface Row {
  bucket: number;
  failed: number;
  waited: number;
  skipped: string;
  runs: number;
}

const empty = (): OutcomeCounts => ({ first: 0, movedOn: 0, waited: 0, failed: 0 });

/** The first skip that moved a run on, or null when every skip was down to how the job is set up. */
export function moveReason(skipped: { reason: string }[]): MoveReason | null {
  for (const step of skipped) {
    const reason = MOVE_REASONS[step.reason as SkipReason];
    if (reason) return reason;
  }
  return null;
}

/** The workspace's routing outcomes in `window`, a bar each of `buckets`. */
export async function routeOutcomes(
  db: Db,
  workspaceId: string,
  window: Window,
  buckets: Buckets = chartBuckets(window),
): Promise<RouteOutcomes> {
  const { bucketMs, origin } = buckets;
  const rows = await db.all<Row>(sql`
    select cast((${table.createdAt} - ${origin}) / ${bucketMs} as integer) as bucket,
      ${table.step} is null as failed, ${table.waitedAt} is not null as waited,
      ${table.skipped} as skipped, count(*) as runs
    from ${table}
    where ${table.workspaceId} = ${workspaceId} and ${table.createdAt} >= ${window.from}
      and ${table.createdAt} < ${window.to}
    group by 1, 2, 3, 4`);

  const bars: OutcomeBucket[] = bucketStarts(window, buckets).map((start) => ({
    start,
    ...empty(),
  }));
  const totals = empty();
  const reasons = new Map<MoveReason, number>();
  for (const row of rows) {
    const runs = Number(row.runs);
    const bar = bars[Math.min(bars.length - 1, Math.max(0, Number(row.bucket)))]!;
    let outcome: keyof OutcomeCounts = "first";
    if (Number(row.failed)) outcome = "failed";
    else if (Number(row.waited)) outcome = "waited";
    else {
      const reason = moveReason(JSON.parse(row.skipped) as { reason: string }[]);
      if (reason) {
        outcome = "movedOn";
        reasons.set(reason, (reasons.get(reason) ?? 0) + runs);
      }
    }
    bar[outcome] += runs;
    totals[outcome] += runs;
  }

  return {
    from: window.from,
    to: window.to,
    bucketMs,
    runs: totals.first + totals.movedOn + totals.waited + totals.failed,
    ...totals,
    reasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    buckets: bars,
  };
}
