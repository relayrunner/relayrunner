/**
 * Admin › Jobs: how many jobs finished across every installation, by result. Each job is counted
 * once, when job_timing first records it finished (src/job-timings.ts), into job_count's row for
 * its hour and installation. The report reads those rows, so it never reads single jobs.
 */
import { gte, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { usesRelayRunner } from "./webhook-queue.ts";

const table = schema.jobCount;
const HOUR_MS = 3_600_000;

const RESULTS = ["success", "failed", "cancelled"] as const;
type Result = (typeof RESULTS)[number];
type Counts = Record<Result, number>;

/** Matches History's split (isFailure in apps/web/src/lib/runs.ts): anything else that ended is cancelled. */
function resultOf(conclusion: string | null): Result {
  if (conclusion === "success") return "success";
  if (conclusion === "failure" || conclusion === "timed_out") return "failed";
  return "cancelled";
}

/**
 * Whether a finished job counts: skipped jobs never ran, and picks only route their run, so
 * neither does (like on the Usage page).
 */
export function countsAsJob(conclusion: string | null, labels: string[]) {
  return conclusion !== "skipped" && !usesRelayRunner(labels);
}

/** Adds a job that just finished to its hour. */
export async function countFinishedJob(
  db: Db,
  installationId: number,
  conclusion: string | null,
  completedAt: Date,
) {
  const hour = new Date(Math.floor(completedAt.getTime() / HOUR_MS) * HOUR_MS);
  const result = resultOf(conclusion);
  await db
    .insert(table)
    .values({ hour, installationId, [result]: 1 })
    .onConflictDoUpdate({
      target: [table.hour, table.installationId],
      set: { [result]: sql`${table[result]} + 1` },
    });
}

export const JOB_COUNT_RANGES = [1, 7, 30, 90] as const;

/** Every installation's hours since the start of the hour `days` ago. */
export function jobCountRows(db: Db, days: number, now = Date.now()) {
  const since = Math.floor((now - days * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
  return db
    .select()
    .from(table)
    .where(gte(table.hour, new Date(since)));
}

export type JobCountReport = {
  totals: Counts;
  /** Per hour with jobs, oldest first. The chart groups them into its bars. */
  hours: (Counts & { at: number })[];
  /** Per installation with jobs, most jobs first. */
  installations: (Counts & { installationId: number })[];
};

const zero = (): Counts => ({ success: 0, failed: 0, cancelled: 0 });
const add = (into: Counts, from: Counts) => {
  for (const result of RESULTS) into[result] += from[result];
};
const jobs = (counts: Counts) => counts.success + counts.failed + counts.cancelled;

/** Sums the rows per hour, per installation and overall, leaving out installations `skip` names. */
export function summarizeJobCounts(
  rows: Awaited<ReturnType<typeof jobCountRows>>,
  skip: (installationId: number) => boolean = () => false,
): JobCountReport {
  const totals = zero();
  const hours = new Map<number, Counts & { at: number }>();
  const installations = new Map<number, Counts & { installationId: number }>();
  for (const row of rows) {
    if (skip(row.installationId)) continue;
    const at = row.hour.getTime();
    if (!hours.has(at)) hours.set(at, { at, ...zero() });
    if (!installations.has(row.installationId))
      installations.set(row.installationId, { installationId: row.installationId, ...zero() });
    add(totals, row);
    add(hours.get(at)!, row);
    add(installations.get(row.installationId)!, row);
  }
  return {
    totals,
    hours: [...hours.values()].toSorted((a, b) => a.at - b.at),
    installations: [...installations.values()].toSorted((a, b) => jobs(b) - jobs(a)),
  };
}
