/**
 * Signals: patterns in a workspace's CI that cost it time or money, each with the repos and
 * workflows it affects, for the Signals page. Every signal belongs to one area: speed (why CI is
 * slow), cost (why it costs this much) or complexity (whether it does more than it needs to).
 *
 * The hourly cron queues one task per installation (src/installation-tasks.ts), which works out
 * the installation's last two UTC days from job_timing and workflow_run and replaces their
 * signal_day rows. The page then sums a few rows per day, whatever the range, instead of reading
 * every run. An installation with no rows yet gets the last BACKFILL_DAYS at once.
 */
import { and, eq, gte, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { PriceBook } from "@relayrunner/providers";
import { type Db, createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { enqueueInstallationTasks } from "./installation-tasks.ts";
import {
  BILLED_MINUTES,
  cents,
  DAY_MS,
  DURATION_MS,
  rateFor,
  runnerClass,
  SHORT_JOB_SECONDS,
} from "./job-timings.ts";
import { loadPriceBook } from "./prices.ts";

export type SignalArea = "speed" | "cost" | "complexity";

/** Every signal, by the area it answers to. The page's titles and copy live in the web app. */
export const SIGNALS = {
  // Runs that kept going after a newer run of the same workflow started on the same branch.
  "no-concurrency": "cost",
  // A commit that ran a workflow from both push and pull_request: the push run is the extra one.
  "same-commit": "cost",
  // Jobs under a minute on a billed runner, which pay for the rest of the minute.
  "short-jobs": "cost",
} as const satisfies Record<string, SignalArea>;

export type SignalId = keyof typeof SIGNALS;

// signal_day rows that hold every counted job, for the page's totals and the threshold.
const TOTAL = "total";
// Days each hourly run works out again: today and yesterday, so a late webhook still counts.
const RECOMPUTE_DAYS = 2;
// Days an installation's first run works out: inside job_timing's RAW_RETENTION_DAYS (31), which
// keeps single jobs that long.
const BACKFILL_DAYS = 30;
// A signal shows once it covers this many minutes and this share of all the range's job minutes.
const MIN_MINUTES = 30;
const MIN_SHARE = 0.01;
// Rows each signal lists, and the least time a row needs to be listed.
const MAX_ROWS = 5;
const MIN_ROW_MINUTES = 1;

const timing = schema.jobTiming;
const run = schema.workflowRun;
const repo = schema.githubRepository;
const day = schema.signalDay;

type DayRow = typeof day.$inferInsert;

/** Queues a signal rollup for each installation a workspace uses. */
export async function enqueueSignalRollups(env: Env) {
  const db = createDb(env.DB);
  const installations = await db
    .select({ id: schema.githubInstallation.id })
    .from(schema.githubInstallation)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, schema.githubInstallation.id))
    .where(isNull(schema.githubInstallation.suspendedAt));
  await enqueueInstallationTasks(
    env,
    installations.map(({ id }) => ({ kind: "signals", installationId: id })),
  );
}

/**
 * Works out one installation's signals for its last RECOMPUTE_DAYS UTC days (BACKFILL_DAYS on its
 * first run) and replaces those days' signal_day rows in one batch.
 */
export async function rollUpSignals(db: Db, installationId: number, now = Date.now()) {
  const [seen] = await db
    .select({ day: day.day })
    .from(day)
    .where(eq(day.installationId, installationId))
    .limit(1);
  const since = utcDay(now) - ((seen ? RECOMPUTE_DAYS : BACKFILL_DAYS) - 1) * DAY_MS;
  const book = await loadPriceBook(db, now);
  const rows = new Rows();
  const paths = await workflowPaths(db, installationId, since);
  await Promise.all([
    addJobs(db, book, rows, paths, installationId, since),
    addSupersededRuns(db, book, rows, installationId, since),
    addSameCommitRuns(db, book, rows, installationId, since),
  ]);

  const values = rows.values(installationId);
  // A statement binds at most 100 values; a signal_day row has 10.
  const inserts = chunk(values, 9).map((part) => db.insert(day).values(part));
  await db.batch([
    db
      .delete(day)
      .where(and(eq(day.installationId, installationId), gte(day.day, new Date(since)))),
    ...inserts,
  ]);
  return values.length;
}

// Each workflow's file, by repo and name, from the window's runs. job_timing doesn't know it.
async function workflowPaths(db: Db, installationId: number, since: number) {
  const found = await db
    .selectDistinct({
      repositoryId: run.repositoryId,
      name: run.workflowName,
      path: run.workflowPath,
    })
    .from(run)
    .where(
      and(
        eq(run.installationId, installationId),
        gte(run.githubUpdatedAt, new Date(since)),
        isNotNull(run.workflowPath),
      ),
    );
  return new Map(found.map((row) => [`${row.repositoryId}:${row.name}`, row.path]));
}

// Every counted job (the usage report's filter) into the totals, and the short ones on a billed
// runner into short-jobs, with the unused part of their last minute as its time and cost.
async function addJobs(
  db: Db,
  book: PriceBook,
  rows: Rows,
  paths: Map<string, string | null>,
  installationId: number,
  since: number,
) {
  const isShort = sql`(${DURATION_MS} < ${SHORT_JOB_SECONDS * 1000})`;
  const found = await db
    .select({
      day: sql<number>`(${timing.completedAt} / ${DAY_MS}) * ${DAY_MS}`,
      repositoryId: timing.repositoryId,
      repository: sql<string>`max(${timing.repositoryFullName})`,
      workflow: timing.workflowName,
      job: timing.name,
      labels: timing.labels,
      runnerGroupName: timing.runnerGroupName,
      private: repo.private,
      jobs: sql<number>`count(*)`,
      runMs: sql<number>`sum(${DURATION_MS})`,
      billed: sql<number>`sum(${BILLED_MINUTES})`,
      shortJobs: sql<number>`sum(${isShort})`,
      shortRunMs: sql<number>`sum(case when ${isShort} then ${DURATION_MS} else 0 end)`,
      shortBilled: sql<number>`sum(case when ${isShort} then ${BILLED_MINUTES} else 0 end)`,
    })
    .from(timing)
    .leftJoin(repo, eq(repo.id, timing.repositoryId))
    .where(
      and(
        eq(timing.installationId, installationId),
        gte(timing.completedAt, new Date(since)),
        isNotNull(timing.startedAt),
        isNotNull(timing.runnerName),
        ne(sql`coalesce(${timing.conclusion}, '')`, "skipped"),
      ),
    )
    .groupBy(
      sql`1`,
      timing.repositoryId,
      timing.workflowName,
      timing.name,
      timing.labels,
      timing.runnerGroupName,
      repo.private,
    );
  for (const row of found) {
    const at = Number(row.day);
    const rate = rateFor(book, runnerClass(row.labels, row.runnerGroupName), row.private, at);
    const where = { day: at, repositoryId: row.repositoryId, repository: row.repository };
    rows.add({ ...where, signal: TOTAL, subject: "" }, row.jobs, row.runMs, row.billed * rate);
    if (!rate || !row.shortJobs) continue;
    const unusedMs = row.shortBilled * 60_000 - row.shortRunMs;
    rows.add(
      {
        ...where,
        signal: "short-jobs",
        subject: `${row.workflow ?? "Workflow"} › ${row.job}`,
        workflowPath: paths.get(`${row.repositoryId}:${row.workflow}`) ?? null,
      },
      row.shortJobs,
      unusedMs,
      (unusedMs / 60_000) * rate,
    );
  }
}

// The same workflow, matched by id once runs carry one and by name before that.
const SAME_WORKFLOW = (a: string, b: string) =>
  sql.raw(`${b}.workflow_id is ${a}.workflow_id and ${b}.workflow_name is ${a}.workflow_name`);

// A counted job's filter, for the raw queries below.
const COUNTED_JOB = sql.raw(
  "j.started_at is not null and j.runner_name is not null and coalesce(j.conclusion, '') != 'skipped'",
);

type RunJobRow = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  path: string | null;
  runId: number;
  labels: string;
  runnerGroupName: string | null;
  private: number | null;
  completedAt: number;
  runMs: number;
};

// Runs on a branch other than the default that GitHub didn't cancel though a newer run of the same
// workflow started on that branch before they finished. The time is each job's part after the
// newer run started: what a concurrency group with cancel-in-progress would have saved.
async function addSupersededRuns(
  db: Db,
  book: PriceBook,
  rows: Rows,
  installationId: number,
  since: number,
) {
  const found = await db.all<RunJobRow>(sql`
    with older as (
      select o.*, (
        select min(n.run_started_at) from workflow_run n
        where n.repository_id = o.repository_id and n.head_branch = o.head_branch
          and ${SAME_WORKFLOW("o", "n")} and n.id != o.id and n.run_started_at > o.run_started_at
      ) as newer_at
      from workflow_run o
      where o.installation_id = ${installationId} and o.github_updated_at >= ${since}
        and o.status = 'completed' and coalesce(o.conclusion, '') != 'cancelled'
        and o.event in ('push', 'pull_request') and o.run_started_at is not null
        and o.head_branch != coalesce(o.default_branch, 'main')
    )
    select o.repository_id as repositoryId, o.repository_full_name as repository,
      o.workflow_name as workflow, o.workflow_path as path, o.id as runId,
      j.labels as labels, j.runner_group_name as runnerGroupName, r.private as private,
      j.completed_at as completedAt, j.completed_at - max(j.started_at, o.newer_at) as runMs
    from older o
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
    left join github_repository r on r.id = o.repository_id
    where o.newer_at is not null and j.completed_at > o.newer_at and j.completed_at >= ${since}
      and ${COUNTED_JOB}`);
  addRunJobs(book, rows, "no-concurrency", found, false);
}

// Push runs whose commit also ran the same workflow from a pull request. The push run is the
// extra one, so its jobs are the time and cost; the count is commits.
async function addSameCommitRuns(
  db: Db,
  book: PriceBook,
  rows: Rows,
  installationId: number,
  since: number,
) {
  const found = await db.all<RunJobRow>(sql`
    select p.repository_id as repositoryId, p.repository_full_name as repository,
      p.workflow_name as workflow, p.workflow_path as path, p.id as runId,
      j.labels as labels, j.runner_group_name as runnerGroupName, r.private as private,
      j.completed_at as completedAt, max(0, j.completed_at - j.started_at) as runMs
    from workflow_run p
    join job_timing j on j.run_id = p.id and j.run_attempt = p.run_attempt
    left join github_repository r on r.id = p.repository_id
    where p.installation_id = ${installationId} and p.github_updated_at >= ${since}
      and p.event = 'push' and p.run_attempt = 1 and j.completed_at >= ${since} and ${COUNTED_JOB}
      and exists (
        select 1 from workflow_run q
        where q.repository_id = p.repository_id and q.head_sha = p.head_sha
          and q.event = 'pull_request' and ${SAME_WORKFLOW("p", "q")}
      )`);
  addRunJobs(book, rows, "same-commit", found, true);
}

// Adds run-level signal jobs, counting each run once per day and workflow. `billed`: the jobs'
// whole time was billed, rounded up per job; otherwise only part of it is the signal's.
function addRunJobs(
  book: PriceBook,
  rows: Rows,
  signal: SignalId,
  found: RunJobRow[],
  billed: boolean,
) {
  const counted = new Set<string>();
  for (const job of found) {
    const at = utcDay(job.completedAt);
    const labels = JSON.parse(job.labels) as string[];
    const rate = rateFor(
      book,
      runnerClass(labels, job.runnerGroupName),
      job.private === null ? null : Boolean(job.private),
      at,
    );
    const subject = job.workflow ?? "Workflow";
    const key = `${at}:${job.repositoryId}:${subject}:${job.runId}`;
    const first = !counted.has(key);
    counted.add(key);
    const minutes = job.runMs / 60_000;
    rows.add(
      {
        day: at,
        signal,
        repositoryId: job.repositoryId,
        repository: job.repository,
        subject,
        workflowPath: job.path,
      },
      first ? 1 : 0,
      job.runMs,
      (billed ? Math.max(1, Math.ceil(minutes)) : minutes) * rate,
    );
  }
}

type RowKey = {
  day: number;
  signal: string;
  repositoryId: number;
  repository: string;
  subject: string;
  workflowPath?: string | null;
};

// signal_day rows being summed, by their primary key.
class Rows {
  #rows = new Map<string, DayRow>();

  add(key: RowKey, count: number, runMs: number, cost: number) {
    const id = `${key.day}:${key.signal}:${key.repositoryId}:${key.subject}`;
    const row = this.#rows.get(id) ?? {
      installationId: 0,
      day: new Date(key.day),
      signal: key.signal,
      repositoryId: key.repositoryId,
      repositoryFullName: key.repository,
      subject: key.subject,
      workflowPath: key.workflowPath ?? null,
      count: 0,
      runMs: 0,
      cost: 0,
    };
    row.count += Number(count);
    row.runMs += Math.round(Number(runMs));
    row.cost += cost;
    this.#rows.set(id, row);
  }

  values(installationId: number) {
    return [...this.#rows.values()].map((row) => ({
      ...row,
      installationId,
      cost: cents(row.cost),
    }));
  }
}

export interface SignalRow {
  repository: string;
  /** The workflow, or "workflow › job". */
  subject: string;
  workflowPath: string | null;
  count: number;
  minutes: number;
  /** Estimated USD. */
  cost: number;
}

export interface Signal {
  id: SignalId;
  area: SignalArea;
  count: number;
  minutes: number;
  cost: number;
  /** The rows with the most time first, at most MAX_ROWS. */
  rows: SignalRow[];
}

export interface SignalsReport {
  days: number;
  /** Every counted job in the range, for the area summaries. */
  totals: { jobs: number; minutes: number; cost: number };
  /** Signals over the threshold, the most time first. */
  signals: Signal[];
}

/**
 * The workspace's signals over the last `days` whole UTC days and today. A signal shows when it
 * covers at least MIN_MINUTES and MIN_SHARE of every job's minutes.
 */
export async function signalsReport(
  db: Db,
  workspaceId: string,
  days = 30,
  now = Date.now(),
): Promise<SignalsReport> {
  const since = new Date(utcDay(now) - (days - 1) * DAY_MS);
  const found = await db
    .select({
      signal: day.signal,
      repository: sql<string>`max(${day.repositoryFullName})`,
      subject: day.subject,
      workflowPath: sql<string | null>`max(${day.workflowPath})`,
      count: sql<number>`sum(${day.count})`,
      runMs: sql<number>`sum(${day.runMs})`,
      cost: sql<number>`sum(${day.cost})`,
    })
    .from(day)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, day.installationId))
    .where(and(eq(schema.workspace.id, workspaceId), gte(day.day, since)))
    .groupBy(day.signal, day.repositoryId, day.subject);

  const totals = { jobs: 0, minutes: 0, cost: 0 };
  const bySignal = new Map<SignalId, Signal>();
  for (const row of found) {
    const minutes = Number(row.runMs) / 60_000;
    const cost = Number(row.cost);
    if (row.signal === TOTAL) {
      totals.jobs += Number(row.count);
      totals.minutes += minutes;
      totals.cost += cost;
      continue;
    }
    if (!(row.signal in SIGNALS)) continue;
    const id = row.signal as SignalId;
    const signal = bySignal.get(id) ?? {
      id,
      area: SIGNALS[id],
      count: 0,
      minutes: 0,
      cost: 0,
      rows: [],
    };
    signal.count += Number(row.count);
    signal.minutes += minutes;
    signal.cost += cost;
    signal.rows.push({
      repository: row.repository,
      subject: row.subject,
      workflowPath: row.workflowPath,
      count: Number(row.count),
      minutes,
      cost,
    });
    bySignal.set(id, signal);
  }

  const floor = Math.max(MIN_MINUTES, totals.minutes * MIN_SHARE);
  const signals = [...bySignal.values()]
    .filter((signal) => signal.minutes >= floor)
    .map((signal) => ({
      ...signal,
      minutes: Math.round(signal.minutes),
      cost: cents(signal.cost),
      rows: signal.rows
        .filter((row) => row.minutes >= MIN_ROW_MINUTES)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, MAX_ROWS)
        .map((row) => ({ ...row, minutes: Math.round(row.minutes), cost: cents(row.cost) })),
    }))
    .sort((a, b) => b.minutes - a.minutes);
  return {
    days,
    totals: { jobs: totals.jobs, minutes: Math.round(totals.minutes), cost: cents(totals.cost) },
    signals,
  };
}

// The UTC midnight starting the day `ms` falls on.
function utcDay(ms: number) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}
