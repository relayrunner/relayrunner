import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, asc, eq, gte, isNotNull, isNull, lt, ne, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { type GitHubRunner, githubRate, type PriceBook } from "@relayrunner/providers";
import { type Db, schema } from "./db/index.ts";
import { countFinishedJob, countsAsJob } from "./job-counts.ts";
import { findInstallation } from "./installations.ts";
import { parseDate } from "./jobs.ts";
import { loadPriceBook } from "./prices.ts";
import { routeIdFromLabels } from "./routing.ts";

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;

const table = schema.jobTiming;
const daily = schema.jobTimingDaily;
const { jobCount, jobCountDay, jobCountHour } = schema;
export const DAY_MS = 86_400_000;

// GitHub bills a job by the minute, rounded up. A job that finishes in under this is the free-checks
// opportunity: it pays for a whole minute however little of it ran.
export const SHORT_JOB_SECONDS = 60;

/**
 * Which per-minute rate a job pays. GitHub-hosted classes follow GitHub's standard runner prices;
 * `self-hosted` covers a self-hosted runner (including RelayRunner's own picks and machines), which
 * GitHub doesn't charge for. `other` is a label we can't price, such as a larger runner, and is
 * counted at the Linux 2-core rate, so the estimate is a floor.
 */
export type RunnerClass = GitHubRunner | "self-hosted" | "other";

export const RUNNER_LABELS: Record<RunnerClass, string> = {
  "linux-1-core": "Linux 1-core",
  "linux-2-core": "Linux 2-core",
  "linux-arm-2-core": "Linux 2-core Arm",
  "windows-2-core": "Windows 2-core",
  "windows-arm-2-core": "Windows 2-core Arm",
  macos: "macOS",
  "self-hosted": "Self-hosted",
  other: "Other (priced as Linux 2-core)",
};

/** What a minute cost on a runner class in a private repo at `at` (epoch ms, now by default). */
export function classRate(book: PriceBook, cls: RunnerClass, at = Date.now()) {
  if (cls === "self-hosted") return 0;
  return githubRate(book, cls === "other" ? "linux-2-core" : cls, at) ?? 0;
}

/**
 * What a minute cost on a runner class in a repo: standard runners are free in public repos, and
 * unknown visibility counts as private, so a missing mirror row never hides a cost.
 */
export function rateFor(
  book: PriceBook,
  cls: RunnerClass,
  isPrivate: boolean | null | undefined,
  at = Date.now(),
) {
  return isPrivate === false ? 0 : classRate(book, cls, at);
}

/**
 * Splits a report's window where prices changed, so each stretch is priced at what a minute cost
 * then. `period` is SQL for which stretch a row's time (`column`, epoch ms) falls in, to select;
 * `groupBy` is what to add to the query's grouping (nothing when no price changed in the window,
 * so the split adds no rows); `at` turns a period back into a moment inside its stretch.
 */
export function pricePeriods(book: PriceBook, column: SQLiteColumn, since: number, now: number) {
  const changes = book.changes.filter((change) => change > since && change <= now);
  const period = changes.length
    ? sql<number>`(${sql.join(
        changes.map((change) => sql`(${column} >= ${change})`),
        sql` + `,
      )})`
    : sql<number>`0`;
  return {
    period,
    groupBy: changes.length ? [period] : [],
    at: (period: number) => (period > 0 ? changes[period - 1]! : since),
  };
}

export const GITHUB_HOSTED_GROUP = "GitHub Actions";

/**
 * Classifies a job by its runs-on labels and, once a runner took it, the runner's group. Applied when
 * the report is read, so changing the rules or the rates needs no backfill.
 */
export function runnerClass(labels: string[], runnerGroupName?: string | null): RunnerClass {
  const lower = labels.map((label) => label.toLowerCase());
  // A pick (`runs-on: relayrunner`) or a route's machine is self-hosted too.
  if (lower.includes("self-hosted") || lower.includes("relayrunner") || routeIdFromLabels(labels))
    return "self-hosted";
  // A runner group other than GitHub's own means the org's runners, unless the labels name a hosted
  // image (larger hosted runners can sit in custom groups).
  const hosted = lower.find((label) => /^(ubuntu|windows|macos)-/.test(label));
  if (!hosted)
    return runnerGroupName && runnerGroupName !== GITHUB_HOSTED_GROUP ? "self-hosted" : "other";
  if (hosted.startsWith("macos")) return "macos";
  if (hosted === "windows-11-arm") return "windows-arm-2-core";
  if (hosted.startsWith("windows"))
    return /^windows-(latest|\d{4})$/.test(hosted) ? "windows-2-core" : "other";
  if (hosted === "ubuntu-slim") return "linux-1-core";
  const ubuntu = /^ubuntu-(latest|\d{2}\.\d{2})(-arm)?$/.exec(hosted);
  if (ubuntu) return ubuntu[2] ? "linux-arm-2-core" : "linux-2-core";
  return "other";
}

/**
 * Stores a job's timing, for every job in a connected repo, whoever's runner it asked for. Each
 * delivery carries the job's whole state, so `queued` writes the row, `in_progress` adds its runner
 * and start, and `completed` its finish and conclusion. A finished row never changes again, so an
 * unordered or redelivered webhook never rewinds it. Rows still going (no completedAt) are what the
 * Runs page shows while a run is live; every report reads finished rows only. Skipped when the
 * installation has no row yet.
 */
export async function recordJobTiming(db: Db, message: WorkflowJobMessage): Promise<boolean> {
  const { installationId, job, repository } = message;
  if (!installationId || !(await findInstallation(db, installationId))) return false;
  const finished = job.status === "completed";
  const completedAt = finished ? parseDate(job.completedAt) : null;
  const [written] = await db
    .insert(table)
    .values({
      id: job.id,
      installationId,
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      runId: job.runId,
      runAttempt: job.runAttempt,
      workflowName: job.workflowName,
      name: job.name,
      labels: job.labels,
      conclusion: finished ? job.conclusion : null,
      runnerName: job.runnerName,
      runnerGroupName: job.runnerGroupName ?? null,
      queuedAt: parseDate(job.createdAt),
      startedAt: parseDate(job.startedAt),
      completedAt,
    })
    .onConflictDoUpdate({
      target: table.id,
      set: {
        conclusion: sql`excluded.conclusion`,
        runnerName: sql`coalesce(excluded.runner_name, ${table.runnerName})`,
        runnerGroupName: sql`coalesce(excluded.runner_group_name, ${table.runnerGroupName})`,
        queuedAt: sql`coalesce(${table.queuedAt}, excluded.queued_at)`,
        startedAt: sql`coalesce(excluded.started_at, ${table.startedAt})`,
        completedAt: sql`excluded.completed_at`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`${table.completedAt} is null`,
    })
    // A row comes back only when this delivery wrote it, so a redelivered `completed` returns
    // nothing and the job is counted once.
    .returning({ id: table.id });
  if (written && completedAt && countsAsJob(job.conclusion, job.labels))
    await countFinishedJob(db, installationId, job.conclusion, completedAt);
  return true;
}

// How long finished jobs are counted for, as job_timing_daily rows by then. The report's longest
// range is 90 days.
export const JOB_TIMING_RETENTION_DAYS = 90;
// How long a finished job keeps its own job_timing row before its day is rolled up into
// job_timing_daily: job times' longest range (MAX_DAYS in src/job-times.ts) and a day to spare.
// The Runs page and job times read single jobs, so they only look this far back.
export const RAW_RETENTION_DAYS = 31;
// Days rolled up per hourly run, so a backlog clears over a few runs instead of one long one.
const ROLLUP_DAYS_PER_RUN = 10;
// A job GitHub never said finished (a lost `completed` webhook) is dropped this long after it was
// first seen: past a day in the queue and five days running, GitHub has given up on it too.
const UNFINISHED_RETENTION_DAYS = 7;
// Rows deleted per statement, so one purge never runs long. The hourly cron catches up on the rest.
const PURGE_BATCH = 5_000;

/**
 * The hourly cleanup: rolls finished jobs past RAW_RETENTION_DAYS up into job_timing_daily, drops
 * daily rows and job counts past the report's range, and drops unfinished jobs GitHub has given up on. Returns
 * how many job_timing rows went.
 */
export async function purgeOldJobTimings(db: Db, now = Date.now()): Promise<number> {
  // Rolled up first, so a day that has just aged out of the report's range goes in this run.
  const finished = await rollUpJobTimings(db, now);
  const retained = new Date(now - JOB_TIMING_RETENTION_DAYS * DAY_MS);
  const [unfinished] = await Promise.all([
    purgeBefore(
      db,
      table,
      table.createdAt,
      new Date(now - UNFINISHED_RETENTION_DAYS * DAY_MS),
      isNull(table.completedAt),
    ),
    purgeBefore(db, daily, daily.day, retained),
    purgeBefore(db, jobCountHour, jobCountHour.hour, retained),
    purgeBefore(db, jobCount, jobCount.hour, retained),
    purgeBefore(db, jobCountDay, jobCountDay.day, retained),
  ]);
  return finished + unfinished;
}

/**
 * Moves each UTC day of finished jobs older than RAW_RETENTION_DAYS out of job_timing and into
 * job_timing_daily, oldest first, up to ROLLUP_DAYS_PER_RUN days. Each day's sums and its delete
 * run as one batch, which D1 runs as a transaction, so no job is ever counted twice or lost. A
 * day already partly rolled up (a job that finished late) adds to its rows. Jobs the report
 * doesn't count (skipped, or never run) are dropped without a trace. Returns how many rows went.
 */
export async function rollUpJobTimings(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(utcDay(now - RAW_RETENTION_DAYS * DAY_MS));
  const d1 = db.$client;
  let moved = 0;
  for (let i = 0; i < ROLLUP_DAYS_PER_RUN; i += 1) {
    // job_timing_completed_idx.
    const [oldest] = await db
      .select({ completedAt: table.completedAt })
      .from(table)
      .where(lt(table.completedAt, cutoff))
      .orderBy(asc(table.completedAt))
      .limit(1);
    if (!oldest?.completedAt) break;
    const start = utcDay(oldest.completedAt.getTime());
    const end = start + DAY_MS;
    const [, deleted] = await d1.batch([
      d1.prepare(ROLLUP_SQL).bind(start, end),
      d1
        .prepare("delete from job_timing where completed_at >= ?1 and completed_at < ?2")
        .bind(start, end),
    ]);
    moved += deleted.meta.changes ?? 0;
  }
  return moved;
}

// One day's counted jobs (the same filter and sums as usageReport), added to job_timing_daily.
// The upsert's SELECT needs a WHERE for SQLite to parse its ON CONFLICT.
const ROLLUP_SQL = `
  insert into job_timing_daily (
    installation_id, day, repository_id, repository_full_name, labels, runner_group_name,
    jobs, short_jobs, run_ms, billed_minutes, short_billed_minutes
  )
  select installation_id, ?1, repository_id, max(repository_full_name), labels, runner_group,
    count(*), sum(run_ms < ${SHORT_JOB_SECONDS * 1000}), sum(run_ms), sum(billed),
    sum(case when run_ms < ${SHORT_JOB_SECONDS * 1000} then billed else 0 end)
  from (
    select installation_id, repository_id, repository_full_name, labels,
      coalesce(runner_group_name, '') as runner_group,
      max(0, completed_at - started_at) as run_ms,
      max(1, (max(0, completed_at - started_at) + 59999) / 60000) as billed
    from job_timing
    where completed_at >= ?1 and completed_at < ?2
      and started_at is not null and runner_name is not null
      and coalesce(conclusion, '') != 'skipped'
  )
  where true
  group by installation_id, repository_id, labels, runner_group
  on conflict (installation_id, day, repository_id, labels, runner_group_name) do update set
    repository_full_name = excluded.repository_full_name,
    jobs = jobs + excluded.jobs,
    short_jobs = short_jobs + excluded.short_jobs,
    run_ms = run_ms + excluded.run_ms,
    billed_minutes = billed_minutes + excluded.billed_minutes,
    short_billed_minutes = short_billed_minutes + excluded.short_billed_minutes`;

// The UTC midnight starting the day `ms` falls on.
function utcDay(ms: number) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Deletes a table's rows whose `column` is before `cutoff` (and that match `where`), PURGE_BATCH
 * at a time and at most 10 batches a call. Returns how many rows went.
 */
export async function purgeBefore(
  db: Db,
  target: SQLiteTable,
  column: SQLiteColumn,
  cutoff: Date | number,
  where?: SQL,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < 10; i += 1) {
    const result = await db.run(sql`
      delete from ${target} where rowid in (
        select rowid from ${target} where ${and(lt(column, cutoff), where)} limit ${PURGE_BATCH})`);
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < PURGE_BATCH) break;
  }
  return deleted;
}

// The per-job sums a report row carries, all starting at zero.
const COUNTERS = [
  "jobs",
  "shortJobs",
  "runSeconds",
  "billedMinutes",
  "shortBilledMinutes",
  "cost",
  "shortCost",
  "roundingCost",
] as const;
type Counters = Record<(typeof COUNTERS)[number], number>;

export interface UsageRow extends Counters {
  runnerClass: RunnerClass;
  label: string;
  /** USD per minute in a private repo. */
  perMinute: number;
}

export interface UsageReport {
  days: number;
  shortJobSeconds: number;
  /**
   * runSeconds: time the jobs ran. billedMinutes: after rounding each job up. shortBilledMinutes:
   * the billed minutes of jobs under a minute. cost, shortCost: estimated USD after free
   * public-repo minutes. roundingCost: what rounding up added on top of the time run.
   */
  totals: Counters;
  byRunner: UsageRow[];
  /** Repos with the most short-job cost first. */
  byRepository: {
    repository: string;
    private: boolean | null;
    jobs: number;
    shortJobs: number;
    shortCost: number;
  }[];
}

/**
 * The workspace's finished jobs from the last `days` days: how many ran under a minute, and what
 * GitHub's round-up cost. Counts only jobs a runner ran (not skipped, not cancelled while queued).
 * Sums are grouped by the columns runnerClass reads, so classification happens per group, not per
 * job. Jobs past RAW_RETENTION_DAYS come from job_timing_daily, whole days only: the range's
 * first, partial day is left out of those.
 */
export async function usageReport(db: Db, workspaceId: string, days = 30): Promise<UsageReport> {
  const now = Date.now();
  const since = new Date(now - days * DAY_MS);
  const book = await loadPriceBook(db, now);
  const [recent, older] = await Promise.all([
    recentUsage(db, book, workspaceId, since, now),
    dailyUsage(db, book, workspaceId, since, now),
  ]);
  const rows = [...recent, ...older];

  const totals = zero();
  const byRunner = new Map<RunnerClass, UsageRow>();
  const byRepository = new Map<string, UsageReport["byRepository"][number]>();
  for (const row of rows) {
    const cls = runnerClass(row.labels, row.runnerGroupName);
    const perMinute = rateFor(book, cls, row.private, row.pricedAt);
    const runSeconds = Number(row.runMs) / 1000;
    const billedMinutes = Number(row.billedMinutes);
    const shortBilledMinutes = Number(row.shortBilledMinutes);
    const sums: Counters = {
      jobs: Number(row.jobs),
      shortJobs: Number(row.shortJobs),
      runSeconds,
      billedMinutes,
      shortBilledMinutes,
      cost: billedMinutes * perMinute,
      shortCost: shortBilledMinutes * perMinute,
      roundingCost: (billedMinutes - runSeconds / 60) * perMinute,
    };
    add(totals, sums);
    const runner = byRunner.get(cls) ?? {
      runnerClass: cls,
      label: RUNNER_LABELS[cls],
      perMinute: classRate(book, cls, now),
      ...zero(),
    };
    add(runner, sums);
    byRunner.set(cls, runner);

    const repo = byRepository.get(row.repository) ?? {
      repository: row.repository,
      private: row.private ?? null,
      jobs: 0,
      shortJobs: 0,
      shortCost: 0,
    };
    repo.jobs += sums.jobs;
    repo.shortJobs += sums.shortJobs;
    repo.shortCost += sums.shortCost;
    byRepository.set(row.repository, repo);
  }

  return {
    days,
    shortJobSeconds: SHORT_JOB_SECONDS,
    totals: rounded(totals),
    byRunner: [...byRunner.values()]
      .map(rounded)
      .sort((a, b) => b.shortCost - a.shortCost || b.jobs - a.jobs),
    byRepository: [...byRepository.values()]
      .map((repo) => ({ ...repo, shortCost: cents(repo.shortCost) }))
      .sort((a, b) => b.shortCost - a.shortCost || b.shortJobs - a.shortJobs)
      .slice(0, 10),
  };
}

/** A finished job's run time, start to finish, in SQL. */
export const DURATION_MS = sql`max(0, ${table.completedAt} - ${table.startedAt})`;
/** The minutes GitHub bills a job: its run time rounded up, at least one. */
export const BILLED_MINUTES = sql`max(1, (${DURATION_MS} + 59999) / 60000)`;

// The usage report's sums from job_timing, for jobs that finished since `since`, with the moment
// their prices are read at.
async function recentUsage(db: Db, book: PriceBook, workspaceId: string, since: Date, now: number) {
  const prices = pricePeriods(book, table.completedAt, since.getTime(), now);
  const durationMs = DURATION_MS;
  const billed = BILLED_MINUTES;
  const isShort = sql`(${durationMs} < ${SHORT_JOB_SECONDS * 1000})`;
  const rows = await db
    .select({
      period: prices.period,
      labels: table.labels,
      runnerGroupName: table.runnerGroupName,
      repository: table.repositoryFullName,
      private: schema.githubRepository.private,
      jobs: sql<number>`count(*)`,
      shortJobs: sql<number>`sum(${isShort})`,
      runMs: sql<number>`sum(${durationMs})`,
      billedMinutes: sql<number>`sum(${billed})`,
      shortBilledMinutes: sql<number>`sum(case when ${isShort} then ${billed} else 0 end)`,
    })
    .from(table)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, table.installationId))
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, table.repositoryId))
    .where(
      and(
        eq(schema.workspace.id, workspaceId),
        gte(table.completedAt, since),
        isNotNull(table.startedAt),
        isNotNull(table.runnerName),
        ne(sql`coalesce(${table.conclusion}, '')`, "skipped"),
      ),
    )
    .groupBy(
      ...prices.groupBy,
      table.labels,
      table.runnerGroupName,
      table.repositoryFullName,
      schema.githubRepository.private,
    );
  return rows.map(({ period, ...row }) => ({ ...row, pricedAt: prices.at(Number(period)) }));
}

// The same sums from job_timing_daily, for whole days that start at or after `since`.
async function dailyUsage(db: Db, book: PriceBook, workspaceId: string, since: Date, now: number) {
  const prices = pricePeriods(book, daily.day, since.getTime(), now);
  const rows = await db
    .select({
      period: prices.period,
      labels: daily.labels,
      runnerGroupName: daily.runnerGroupName,
      repository: daily.repositoryFullName,
      private: schema.githubRepository.private,
      jobs: sql<number>`sum(${daily.jobs})`,
      shortJobs: sql<number>`sum(${daily.shortJobs})`,
      runMs: sql<number>`sum(${daily.runMs})`,
      billedMinutes: sql<number>`sum(${daily.billedMinutes})`,
      shortBilledMinutes: sql<number>`sum(${daily.shortBilledMinutes})`,
    })
    .from(daily)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, daily.installationId))
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, daily.repositoryId))
    .where(and(eq(schema.workspace.id, workspaceId), gte(daily.day, since)))
    .groupBy(
      ...prices.groupBy,
      daily.labels,
      daily.runnerGroupName,
      daily.repositoryFullName,
      schema.githubRepository.private,
    );
  return rows.map(({ period, ...row }) => ({
    ...row,
    runnerGroupName: row.runnerGroupName || null,
    pricedAt: prices.at(Number(period)),
  }));
}

function zero(): Counters {
  return Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Counters;
}

function add(into: Counters, sums: Counters) {
  for (const key of COUNTERS) into[key] += sums[key];
}

// Keeps sub-cent precision (a 1-core minute is $0.002) without float noise.
export function cents(value: number) {
  return Math.round(value * 1000) / 1000;
}

function rounded<T extends Counters>(row: T): T {
  return {
    ...row,
    cost: cents(row.cost),
    shortCost: cents(row.shortCost),
    roundingCost: cents(row.roundingCost),
    runSeconds: Math.round(row.runSeconds),
  };
}
