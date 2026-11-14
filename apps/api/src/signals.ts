/**
 * Signals: patterns in a workspace's CI that cost it time or money, each with the repos and
 * workflows it affects, for the Signals page. Every signal belongs to one area: speed (why CI is
 * slow), cost (why it costs this much) or complexity (whether it does more than it needs to).
 *
 * The hourly cron queues one task per installation that finished a job in the last two hours
 * (src/installation-tasks.ts). The task works out the installation's current UTC day from
 * job_timing and workflow_run, and yesterday too for the first hours after midnight so late
 * webhooks still land, and replaces those days' signal_day rows. The page then sums a few rows per
 * day, whatever the range, instead of reading every run. An installation with no rows yet gets the
 * last 30 days at once, as many whole days as job_timing keeps single jobs.
 */
import { and, eq, exists, gte, isNull, sql } from "drizzle-orm";
import type { PriceBook } from "@relayrunner/providers";
import { type Db, createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { enqueueInstallationTasks } from "./installation-tasks.ts";
import { RAN_ON_RUNNER } from "./job-times.ts";
import {
  BILLED_MINUTES,
  cents,
  DAY_MS,
  DURATION_MS,
  RAW_RETENTION_DAYS,
  rateFor,
  runnerClass,
  SHORT_JOB_SECONDS,
  utcDay,
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
// How long after UTC midnight each run still works out yesterday, for late webhooks.
const LATE_MS = 3 * 60 * 60_000;
// Only installations that finished a job this recently get a run.
const ACTIVE_MS = 2 * 60 * 60_000;
// A signal shows once it covers this many minutes and this share of all the range's job minutes.
const MIN_MINUTES = 30;
const MIN_SHARE = 0.01;
// Rows each signal lists, and the least time a row needs to be listed.
const MAX_ROWS = 5;
const MIN_ROW_MINUTES = 1;

const timing = schema.jobTiming;
const run = schema.workflowRun;
const day = schema.signalDay;
const installation = schema.githubInstallation;

type DayRow = typeof day.$inferInsert;
// Whether each of the installation's repos is private, by id, for the price of its minutes.
type Privacy = Map<number, boolean>;

/** Queues a signal rollup for each installation a workspace uses that finished a job lately. */
export async function enqueueSignalRollups(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const installations = await db
    .select({ id: installation.id })
    .from(installation)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, installation.id))
    .where(
      and(
        isNull(installation.suspendedAt),
        exists(
          db
            .select({ one: sql`1` })
            .from(timing)
            .where(
              and(
                eq(timing.installationId, installation.id),
                gte(timing.completedAt, new Date(now - ACTIVE_MS)),
              ),
            ),
        ),
      ),
    );
  await enqueueInstallationTasks(
    env,
    installations.map(({ id }) => ({ kind: "signals", installationId: id })),
  );
}

/**
 * Works out one installation's signals for today (and yesterday, just after midnight), or the last
 * 30 days on its first run, and replaces those days' signal_day rows in one batch.
 */
export async function rollUpSignals(db: Db, installationId: number, now = Date.now()) {
  const [seen, book, repos] = await Promise.all([
    db
      .select({ day: day.day })
      .from(day)
      .where(eq(day.installationId, installationId))
      .limit(1)
      .then(([row]) => row),
    loadPriceBook(db, now),
    db
      .select({ id: schema.githubRepository.id, private: schema.githubRepository.private })
      .from(schema.githubRepository)
      .where(eq(schema.githubRepository.installationId, installationId)),
  ]);
  // The first run goes back as far as job_timing keeps single jobs, in whole days.
  const since = seen ? utcDay(now - LATE_MS) : utcDay(now) - (RAW_RETENTION_DAYS - 2) * DAY_MS;
  const privacy: Privacy = new Map(repos.map((repo) => [repo.id, repo.private]));
  const rows = new Rows(installationId);
  const scope = { db, book, rows, privacy, installationId, since };
  await Promise.all([addJobs(scope), addSupersededRuns(scope), addSameCommitRuns(scope)]);

  const values = rows.values();
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

type Scope = {
  db: Db;
  book: PriceBook;
  rows: Rows;
  privacy: Privacy;
  installationId: number;
  since: number;
};

// The price of a minute on these labels in this repo, on the given day.
function rate(
  { book, privacy }: Scope,
  labels: string[],
  group: string | null,
  repositoryId: number,
  at: number,
) {
  return rateFor(book, runnerClass(labels, group), privacy.get(repositoryId) ?? null, at);
}

// Every counted job (the usage report's filter) into the totals, and the short ones on a billed
// runner into short-jobs, with the unused part of their last minute as its time and cost.
async function addJobs(scope: Scope) {
  const { db, rows, installationId, since } = scope;
  const isShort = sql`(${DURATION_MS} < ${SHORT_JOB_SECONDS * 1000})`;
  const found = await db
    .select({
      day: sql<number>`(${timing.completedAt} / ${DAY_MS}) * ${DAY_MS}`,
      repositoryId: timing.repositoryId,
      repository: sql<string>`max(${timing.repositoryFullName})`,
      workflow: timing.workflowName,
      // job_timing doesn't know the workflow's file; its run does.
      workflowPath: sql<string | null>`max(${run.workflowPath})`,
      job: timing.name,
      labels: timing.labels,
      runnerGroupName: timing.runnerGroupName,
      jobs: sql<number>`count(*)`,
      runMs: sql<number>`sum(${DURATION_MS})`,
      billed: sql<number>`sum(${BILLED_MINUTES})`,
      shortJobs: sql<number>`sum(${isShort})`,
      shortRunMs: sql<number>`sum(case when ${isShort} then ${DURATION_MS} else 0 end)`,
      shortBilled: sql<number>`sum(case when ${isShort} then ${BILLED_MINUTES} else 0 end)`,
    })
    .from(timing)
    .leftJoin(run, and(eq(run.id, timing.runId), eq(run.runAttempt, timing.runAttempt)))
    .where(
      and(
        eq(timing.installationId, installationId),
        gte(timing.completedAt, new Date(since)),
        RAN_ON_RUNNER,
      ),
    )
    .groupBy(
      sql`1`,
      timing.repositoryId,
      timing.workflowName,
      timing.name,
      timing.labels,
      timing.runnerGroupName,
    );
  for (const row of found) {
    const at = Number(row.day);
    const perMinute = rate(scope, row.labels, row.runnerGroupName, row.repositoryId, at);
    const where = { day: at, repositoryId: row.repositoryId, repository: row.repository };
    rows.add({ ...where, signal: TOTAL, subject: "" }, row.jobs, row.runMs, row.billed * perMinute);
    if (!perMinute || !row.shortJobs) continue;
    const unusedMs = row.shortBilled * 60_000 - row.shortRunMs;
    rows.add(
      {
        ...where,
        signal: "short-jobs",
        subject: `${row.workflow ?? "Workflow"} › ${row.job}`,
        workflowPath: row.workflowPath,
      },
      row.shortJobs,
      unusedMs,
      (unusedMs / 60_000) * perMinute,
    );
  }
}

// The same workflow, matched by id once runs carry one and by name before that.
const SAME_WORKFLOW = (a: string, b: string) =>
  sql.raw(`${b}.workflow_id is ${a}.workflow_id and ${b}.workflow_name is ${a}.workflow_name`);

// A counted job's filter (RAN_ON_RUNNER), for the raw queries below.
const COUNTED_JOB = sql.raw(
  "j.started_at is not null and j.runner_name is not null and coalesce(j.conclusion, '') != 'skipped'",
);

// The columns addRunJobs reads, from a run `o` and its job `j`.
const RUN_JOB_COLUMNS = sql.raw(`o.repository_id as repositoryId,
  o.repository_full_name as repository, o.workflow_name as workflow, o.workflow_path as path,
  o.id as runId, j.labels as labels, j.runner_group_name as runnerGroupName,
  j.completed_at as completedAt`);

type RunJobRow = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  path: string | null;
  runId: number;
  labels: string;
  runnerGroupName: string | null;
  completedAt: number;
  runMs: number;
};

// Runs on a branch other than the default that GitHub didn't cancel though a newer run of the same
// workflow started on that branch before they finished. The time is each job's part after the
// newer run started: what a concurrency group with cancel-in-progress would have saved.
async function addSupersededRuns(scope: Scope) {
  const { db, installationId, since } = scope;
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
    select ${RUN_JOB_COLUMNS}, j.completed_at - max(j.started_at, o.newer_at) as runMs
    from older o
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
    where o.newer_at is not null and j.completed_at > o.newer_at and j.completed_at >= ${since}
      and ${COUNTED_JOB}`);
  addRunJobs(scope, "no-concurrency", found, false);
}

// Push runs whose commit also ran the same workflow from a pull request. The push run is the
// extra one, so its jobs are the time and cost; the count is commits.
async function addSameCommitRuns(scope: Scope) {
  const { db, installationId, since } = scope;
  const found = await db.all<RunJobRow>(sql`
    select ${RUN_JOB_COLUMNS}, max(0, j.completed_at - j.started_at) as runMs
    from workflow_run o
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
    where o.installation_id = ${installationId} and o.github_updated_at >= ${since}
      and o.event = 'push' and o.run_attempt = 1 and j.completed_at >= ${since} and ${COUNTED_JOB}
      and exists (
        select 1 from workflow_run q
        where q.repository_id = o.repository_id and q.head_sha = o.head_sha
          and q.event = 'pull_request' and ${SAME_WORKFLOW("o", "q")}
      )`);
  addRunJobs(scope, "same-commit", found, true);
}

// Adds run-level signal jobs, counting each run once per day and workflow. `billed`: the jobs'
// whole time was billed, rounded up per job; otherwise only part of it is the signal's.
function addRunJobs(scope: Scope, signal: SignalId, found: RunJobRow[], billed: boolean) {
  const counted = new Set<string>();
  for (const job of found) {
    const at = utcDay(job.completedAt);
    const labels = JSON.parse(job.labels) as string[];
    const perMinute = rate(scope, labels, job.runnerGroupName, job.repositoryId, at);
    const subject = job.workflow ?? "Workflow";
    const key = `${at}:${job.repositoryId}:${subject}:${job.runId}`;
    const first = !counted.has(key);
    counted.add(key);
    const minutes = job.runMs / 60_000;
    scope.rows.add(
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
      (billed ? Math.max(1, Math.ceil(minutes)) : minutes) * perMinute,
    );
  }
}

type RowKey = Pick<DayRow, "signal" | "repositoryId" | "subject" | "workflowPath"> & {
  day: number;
  repository: string;
};

// One installation's signal_day rows being summed, by their primary key.
class Rows {
  #rows = new Map<string, DayRow>();

  constructor(readonly installationId: number) {}

  add(key: RowKey, count: number, runMs: number, cost: number) {
    const id = `${key.day}:${key.signal}:${key.repositoryId}:${key.subject}`;
    const row = this.#rows.get(id) ?? {
      installationId: this.installationId,
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

  values() {
    return [...this.#rows.values()].map((row) => ({ ...row, cost: cents(row.cost) }));
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

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}
