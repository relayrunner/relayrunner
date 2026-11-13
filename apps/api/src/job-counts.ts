/**
 * Admin › Jobs: how many jobs finished across every installation, by result. Each job is counted
 * once, when job_timing first records it finished (src/job-timings.ts), into three rollups
 * (src/db/schema.ts). The report reads at most a row per hour for the chart and a row per
 * installation and day for the breakdown, so it never reads single jobs.
 */
import { and, gte, inArray, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { type Db, schema } from "./db/index.ts";
import { usesRelayRunner } from "./webhook-queue.ts";

const { jobCount, jobCountDay, jobCountHour } = schema;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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

/** Adds a job that just finished to its hour and day, in one round trip. */
export async function countFinishedJob(
  db: Db,
  installationId: number,
  conclusion: string | null,
  completedAt: Date,
) {
  const at = completedAt.getTime();
  const hour = new Date(Math.floor(at / HOUR_MS) * HOUR_MS);
  const day = new Date(Math.floor(at / DAY_MS) * DAY_MS);
  const result = resultOf(conclusion);
  const bump = (column: SQLiteColumn) => ({ [result]: sql`${column} + 1` });
  await db.batch([
    db
      .insert(jobCountHour)
      .values({ hour, [result]: 1 })
      .onConflictDoUpdate({ target: jobCountHour.hour, set: bump(jobCountHour[result]) }),
    db
      .insert(jobCount)
      .values({ installationId, hour, [result]: 1 })
      .onConflictDoUpdate({
        target: [jobCount.installationId, jobCount.hour],
        set: bump(jobCount[result]),
      }),
    db
      .insert(jobCountDay)
      .values({ day, installationId, [result]: 1 })
      .onConflictDoUpdate({
        target: [jobCountDay.day, jobCountDay.installationId],
        set: bump(jobCountDay[result]),
      }),
  ]);
}

export const JOB_COUNT_RANGES = [1, 7, 30, 90] as const;

export type JobCountReport = {
  totals: Counts;
  /** Per hour with jobs, oldest first. The chart groups them into its bars. */
  hours: (Counts & { at: number })[];
  /** Per installation with jobs, most jobs first. */
  installations: (Counts & { installationId: number })[];
};

const zero = (): Counts => ({ success: 0, failed: 0, cancelled: 0 });
const jobs = (counts: Counts) => counts.success + counts.failed + counts.cancelled;
const sums = (table: typeof jobCount | typeof jobCountDay) => ({
  success: sql<number>`sum(${table.success})`,
  failed: sql<number>`sum(${table.failed})`,
  cancelled: sql<number>`sum(${table.cancelled})`,
});

/**
 * Jobs that finished over the last `days`: from the start of the hour a day ago, or else from UTC
 * midnight `days` ago, so the per-day breakdown covers exactly the chart's range. Installations in
 * `exclude` (our own, a handful) are left out, taking their hours out of the chart.
 */
export async function jobCountReport(
  db: Db,
  { days, exclude = [], now = Date.now() }: { days: number; exclude?: number[]; now?: number },
): Promise<JobCountReport> {
  const unit = days <= 1 ? HOUR_MS : DAY_MS;
  const since = new Date(Math.floor((now - days * DAY_MS) / unit) * unit);
  const [all, ours, perInstallation] = await Promise.all([
    db.select().from(jobCountHour).where(gte(jobCountHour.hour, since)),
    exclude.length
      ? db
          .select({ hour: jobCount.hour, ...sums(jobCount) })
          .from(jobCount)
          .where(and(inArray(jobCount.installationId, exclude), gte(jobCount.hour, since)))
          .groupBy(jobCount.hour)
      : [],
    days <= 1
      ? db
          .select({ installationId: jobCount.installationId, ...sums(jobCount) })
          .from(jobCount)
          .where(gte(jobCount.hour, since))
          .groupBy(jobCount.installationId)
      : db
          .select({ installationId: jobCountDay.installationId, ...sums(jobCountDay) })
          .from(jobCountDay)
          .where(gte(jobCountDay.day, since))
          .groupBy(jobCountDay.installationId),
  ]);
  const left = new Map(ours.map((row) => [row.hour.getTime(), row]));
  const totals = zero();
  const hours = all
    .map((row) => {
      const at = row.hour.getTime();
      const counts = { at, ...zero() };
      for (const result of RESULTS) {
        counts[result] = row[result] - (left.get(at)?.[result] ?? 0);
        totals[result] += counts[result];
      }
      return counts;
    })
    .filter((row) => jobs(row) > 0)
    .toSorted((a, b) => a.at - b.at);
  const skip = new Set(exclude);
  return {
    totals,
    hours,
    installations: perInstallation
      .filter((row) => !skip.has(row.installationId))
      .toSorted((a, b) => jobs(b) - jobs(a)),
  };
}
