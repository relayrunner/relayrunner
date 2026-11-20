// The Router page's routing outcomes: of the runs the Router picked a runner for in a window, how
// many took the first step that fit them, how many moved further down the order because a step
// that fits them couldn't take the run then (a busy machine, a spending limit, a runner type that
// stopped picking up jobs), how many queued for a machine, and how many found nowhere to go.
//
// Database cost: one statement, a range of route_decision_workspace_idx (the workspace, created in
// the window), grouped so repeated walks come back once.
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import type { Window } from "./report-window.ts";

const table = schema.routeDecision;

/** Why a run moved past a step that fits it, grouped for the page. */
export type MoveReason = "machines" | "limit" | "unhealthy";

// Skips that change from one run to the next. The others (a step the job didn't set up, a public
// repo, too many labels and so on) say how the job is set up, so the first step that fits is
// whichever comes after them.
const MOVE_REASONS: Record<string, MoveReason> = {
  machine_full: "machines",
  machine_paused: "machines",
  no_machine: "machines",
  github_rate_limited: "machines",
  minutes_limit: "limit",
  minutes_runway: "limit",
  spend_limit: "limit",
  provider_unhealthy: "unhealthy",
};

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
    const reason = MOVE_REASONS[step.reason];
    if (reason) return reason;
  }
  return null;
}

/**
 * The workspace's routing outcomes in `window`, in buckets of `bucketMs` from `origin` (the
 * window's start by default, or the reader's midnight before it so days line up).
 */
export async function routeOutcomes(
  db: Db,
  workspaceId: string,
  window: Window,
  { bucketMs, origin = window.from }: { bucketMs: number; origin?: number },
): Promise<RouteOutcomes> {
  const rows = await db.all<Row>(sql`
    select cast((${table.createdAt} - ${origin}) / ${bucketMs} as integer) as bucket,
      ${table.step} is null as failed, ${table.waitedAt} is not null as waited,
      ${table.skipped} as skipped, count(*) as runs
    from ${table}
    where ${table.workspaceId} = ${workspaceId} and ${table.createdAt} >= ${window.from}
      and ${table.createdAt} < ${window.to}
    group by 1, 2, 3, 4`);

  const count = Math.max(1, Math.ceil((window.to - origin) / bucketMs));
  const buckets: OutcomeBucket[] = Array.from({ length: count }, (_, i) => ({
    start: origin + i * bucketMs,
    ...empty(),
  }));
  const totals = empty();
  const reasons = new Map<MoveReason, number>();
  for (const row of rows) {
    const runs = Number(row.runs);
    const bucket = buckets[Math.min(count - 1, Math.max(0, Number(row.bucket)))];
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
    bucket[outcome] += runs;
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
    buckets,
  };
}
