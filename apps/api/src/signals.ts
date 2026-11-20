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
 * last 30 days at once (liveDays).
 *
 * The same rows hold the page's Breakdown: every counted job by who started its run, its workflow,
 * branch and trigger, and pull request runs by the folders their pull request changed
 * (src/pull-request-paths.ts).
 *
 * A filtered page (one person, repo, workflow, branch or trigger) can't come from those rows, since
 * a signal's rows don't say who or what started their runs. It works the same queries out on the
 * spot instead, narrowed to the filter's runs, over at most liveDays().
 * The runs behind one signal row come from the same queries too (signalRuns).
 */
import { and, eq, exists, gte, inArray, isNull, lt, notLike, sql } from "drizzle-orm";
import type { PriceBook } from "@relayrunner/providers";
import { type Db, createDb, prepare, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { enqueueInstallationTasks } from "./installation-tasks.ts";
import { environmentFor, PICK, RAN_ON_RUNNER } from "./job-times.ts";
import {
  BILLED_MINUTES,
  cents,
  DAY_MS,
  DURATION_MS,
  rateFor,
  runnerClass,
  SHORT_JOB_SECONDS,
  utcDay,
} from "./job-timings.ts";
import { loadPriceBook } from "./prices.ts";
import type { ReportWindow } from "./report-window.ts";
import { LIVE_DAYS } from "./time.ts";
import { routeIdFromLabels } from "./routing.ts";

export type SignalArea = "speed" | "cost" | "complexity";

/** Every signal, by the area it answers to. The page's titles and copy live in the web app. */
export const SIGNALS = {
  // Runs that kept going after a newer run of the same workflow started on the same branch.
  "no-concurrency": "cost",
  // A commit that ran a workflow from both push and pull_request: the push run is the extra one.
  "same-commit": "cost",
  // Jobs under a minute on a billed runner, which pay for the rest of the minute.
  "short-jobs": "cost",
  // Jobs that waited over a minute for a runner to take them, by runs-on labels.
  "queue-waits": "speed",
  // A job that ran alongside others in its run and kept the run going after they all finished.
  "slowest-job": "speed",
  // Jobs that failed in one of their steps and then passed when the run was tried again.
  "flaky-jobs": "speed",
  // Jobs whose runner failed them before any of their steps started, by runs-on labels.
  "runner-failures": "speed",
  // Runs for pull requests that only changed docs, or, where we haven't read a run's files, for
  // commits or pull requests titled as docs changes (docs: in Conventional Commits).
  "docs-changes": "complexity",
  // Runs on a branch other than the default that started FANOUT_JOBS jobs or more.
  "wide-fanout": "complexity",
} as const satisfies Record<string, SignalArea>;

export type SignalId = keyof typeof SIGNALS;

/**
 * How the Breakdown splits counted jobs. The repository view sums the workflow view. The path view
 * holds only pull request runs whose files we read, each under every folder it changed, so its
 * rows overlap.
 */
export const BREAKDOWNS = ["person", "workflow", "branch", "trigger", "path"] as const;
export type BreakdownBy = (typeof BREAKDOWNS)[number] | "repository";

/**
 * What a filtered page narrows to: a Breakdown value, by view. Each is a fact about the whole run,
 * so a run's jobs all match or none do. A workflow is matched by name and a path is a folder of
 * one repo, so both come with their repo.
 */
export type SignalFilter = Partial<Record<BreakdownBy, string>>;

/**
 * The days a filtered page or a signal's runs can cover, today included, and the days an
 * installation's first rollup and its pull request folders go back (LIVE_DAYS).
 */
export const liveDays = () => LIVE_DAYS;

/**
 * A report's whole UTC days, as signal_day keeps them: `start` up to `end` (UTC midnights), and
 * where the filter trend's days start.
 */
export interface DayRange {
  start: number;
  end: number;
  priorStart: number;
}

const dayCount = ({ start, end }: DayRange) => Math.round((end - start) / DAY_MS);

/** The last `days` UTC days, today included, against the days just before. */
export function lastUtcDays(days: number, now = Date.now()): DayRange {
  const end = utcDay(now) + DAY_MS;
  const start = end - days * DAY_MS;
  return { start, end, priorStart: start - days * DAY_MS };
}

/**
 * The UTC days nearest a window the dashboard worked out in the reader's time zone, such as this
 * month: each end to its nearest UTC midnight, and today included while the window runs to now.
 */
export function utcDaysOf(window: ReportWindow, now = Date.now()): DayRange {
  const nearest = (ms: number) => utcDay(ms + DAY_MS / 2);
  const today = utcDay(now);
  const end = window.to > today ? today + DAY_MS : nearest(window.to);
  const start = Math.min(nearest(window.from), end - DAY_MS);
  return { start, end, priorStart: Math.min(nearest(window.prior.from), start - DAY_MS) };
}

/** A range cut to the last `days` days, for reads from single jobs, its prior start moved as much. */
function atMost(range: DayRange, days: number, now: number): DayRange {
  const first = utcDay(now) - (days - 1) * DAY_MS;
  if (range.start >= first) return range;
  const start = Math.min(first, range.end - DAY_MS);
  return { ...range, start, priorStart: range.priorStart + start - range.start };
}

// signal_day rows that hold every counted job, for the page's totals and the threshold.
const TOTAL = "total";
// How long after UTC midnight each run still works out yesterday, for late webhooks.
const LATE_MS = 3 * 60 * 60_000;
// Only installations that finished a job this recently get a run.
const ACTIVE_MS = 2 * 60 * 60_000;
// A job waited for a runner once it was queued this long before one took it: the same minute the
// History page marks as a long wait (LONG_WAIT_MS in the web app).
const QUEUE_WAIT_MS = 60_000;
// A run waited on its slowest job once that job ran this long after every other job finished.
const SLOWEST_JOB_MS = 60_000;
// A run fans out once it starts this many jobs.
const FANOUT_JOBS = 10;
// A signal shows once it covers this many minutes and this share of all the range's job minutes.
const MIN_MINUTES = 30;
const MIN_SHARE = 0.01;
// Rows each signal lists, and the least time a row needs to be listed.
const MAX_ROWS = 5;
const MIN_ROW_MINUTES = 1;
// Breakdown values kept per day, repo and view; the rest share one row with an empty subject.
const MAX_DAY_VALUES = 25;
// Rows each Breakdown view lists before the rest are summed into one.
const MAX_BREAKDOWN_ROWS = 10;

const timing = schema.jobTiming;
const run = schema.workflowRun;
const day = schema.signalDay;
const paths = schema.pullRequestPaths;
const installation = schema.githubInstallation;

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
  const [seen, { book, privacy }] = await Promise.all([
    db
      .select({ day: day.day })
      .from(day)
      .where(eq(day.installationId, installationId))
      .limit(1)
      .then(([row]) => row),
    pricing(db, installationId, now),
  ]);
  // The first run goes back liveDays(), in whole days.
  const since = seen ? utcDay(now - LATE_MS) : utcDay(now) - (liveDays() - 1) * DAY_MS;
  const rows = new Rows();
  await addAll({ db, book, rows, privacy, installationId, since, filter: {} });

  // The rows go in as JSON parameters, a few thousand per statement, so even a first run's 30 days
  // take a handful of D1 queries. Sent straight to D1: Drizzle's batch can't carry a raw statement.
  const values = rows.values();
  const d1 = db.$client;
  const cleared = db
    .delete(day)
    .where(and(eq(day.installationId, installationId), gte(day.day, new Date(since))));
  await d1.batch([
    prepare(db, cleared),
    ...chunk(values, ROWS_PER_INSERT).map((part) =>
      d1.prepare(INSERT_SQL).bind(installationId, JSON.stringify(part)),
    ),
  ]);
  return values.length;
}

const INSERT_SQL = `
  insert into signal_day (installation_id, day, signal, repository_id, repository_full_name,
    subject, workflow_path, runner_key, count, run_ms, cost)
  select ?1, value ->> 'day', value ->> 'signal', value ->> 'repositoryId',
    value ->> 'repositoryFullName', value ->> 'subject', value ->> 'workflowPath',
    value ->> 'runnerKey',
    value ->> 'count', value ->> 'runMs', value ->> 'cost'
  from json_each(?2)`;

// Rows per insert statement: well under D1's limit on one parameter's size.
const ROWS_PER_INSERT = 2000;

type Scope = {
  db: Db;
  book: PriceBook;
  rows: Sink;
  privacy: Privacy;
  installationId: number;
  since: number;
  filter: SignalFilter;
  // For signalRuns: addJobs lists this repo's short, waiting and runner-failed jobs one at a time.
  perJob?: string;
};

// Every signal, the totals and the Breakdown.
async function addAll(scope: Scope) {
  await Promise.all([
    addJobs(scope),
    addSupersededRuns(scope),
    addSameCommitRuns(scope),
    addSlowestJobs(scope),
    addFlakyJobs(scope),
    addDocsRuns(scope),
    addWideRuns(scope),
  ]);
}

// The price book and repo privacy a scope prices minutes with.
async function pricing(db: Db, installationId: number, now: number) {
  const [book, repos] = await Promise.all([
    loadPriceBook(db, now),
    db
      .select({ id: schema.githubRepository.id, private: schema.githubRepository.private })
      .from(schema.githubRepository)
      .where(eq(schema.githubRepository.installationId, installationId)),
  ]);
  return { book, privacy: new Map(repos.map((repo) => [repo.id, repo.private])) as Privacy };
}

// The filter's conditions on a workflow_run row (always true for no filter). Jobs whose run we
// never saw match no filter.
function matching(filter: SignalFilter, alias: string) {
  const run = sql.raw(alias);
  const parts = [];
  if (filter.repository) parts.push(sql`${run}.repository_full_name = ${filter.repository}`);
  if (filter.workflow) parts.push(sql`${run}.workflow_name = ${filter.workflow}`);
  if (filter.person)
    parts.push(sql`coalesce(${run}.started_by_login, ${run}.actor_login) = ${filter.person}`);
  if (filter.branch) parts.push(sql`${run}.head_branch = ${filter.branch}`);
  // Re-runs count as their own trigger, as in the Breakdown.
  if (filter.trigger === "rerun") parts.push(sql`${run}.run_attempt > 1`);
  else if (filter.trigger)
    parts.push(sql`${run}.run_attempt = 1 and ${run}.event = ${filter.trigger}`);
  if (filter.path)
    parts.push(sql`exists (select 1 from pull_request_paths f, json_each(f.areas) a
      where f.repository_id = ${run}.repository_id
        and f.pull_request_number = ${run}.pull_request_number and a.value = ${filter.path})`);
  return parts.length ? sql`(${sql.join(parts, sql` and `)})` : sql`1`;
}

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

// Every counted job (the usage report's filter) into the totals and the Breakdown; the short ones
// on a billed runner into short-jobs, with the unused part of their last minute as its time and
// cost; and the ones that waited for a runner into queue-waits, with the wait as its time. Picks
// (runs-on: relayrunner) only wait for RelayRunner, so they don't count as waiting. With
// `perJob`, only that repo's jobs for those three signals, one at a time with their runs.
async function addJobs(scope: Scope) {
  const { db, rows, installationId, since, perJob } = scope;
  const isShort = sql`(${DURATION_MS} < ${SHORT_JOB_SECONDS * 1000})`;
  const waitMs = sql`(${timing.startedAt} - ${timing.queuedAt})`;
  const waited = sql`(${waitMs} >= ${QUEUE_WAIT_MS} and not ${PICK})`;
  const runnerFailed = sql`(${timing.conclusion} = 'failure' and ${timing.ranSteps} = 0)`;
  // A run counts once, on its first counted job (job_timing_run_idx), even across midnight.
  const first = sql`(${timing.id} = (select min(k.id) from job_timing k
    where k.run_id = ${timing.runId} and k.run_attempt = ${timing.runAttempt}
      and k.started_at is not null and k.runner_name is not null
      and coalesce(k.conclusion, '') != 'skipped'))`;
  // Who started the run, and what: re-runs count as their own trigger.
  const person = sql<string | null>`coalesce(${run.startedByLogin}, ${run.actorLogin})`;
  const trigger = sql<
    string | null
  >`case when ${run.runAttempt} > 1 then 'rerun' else ${run.event} end`;
  const found = await db
    .select({
      // Whole UTC days: a bound number divides as a real, so cast it back.
      day: sql<number>`cast(${timing.completedAt} / ${DAY_MS} as integer) * ${DAY_MS}`,
      repositoryId: timing.repositoryId,
      repository: sql<string>`max(${timing.repositoryFullName})`,
      workflow: timing.workflowName,
      // job_timing doesn't know the workflow's file; its run does.
      workflowPath: sql<string | null>`max(${run.workflowPath})`,
      job: timing.name,
      labels: timing.labels,
      runnerGroupName: timing.runnerGroupName,
      person,
      branch: run.headBranch,
      trigger,
      // The folders the run's pull request changed, when we read them.
      areas: paths.areas,
      jobs: sql<number>`count(*)`,
      runs: sql<number>`sum(${first})`,
      runMs: sql<number>`sum(${DURATION_MS})`,
      billed: sql<number>`sum(${BILLED_MINUTES})`,
      shortJobs: sql<number>`sum(${isShort})`,
      shortRunMs: sql<number>`sum(case when ${isShort} then ${DURATION_MS} else 0 end)`,
      shortBilled: sql<number>`sum(case when ${isShort} then ${BILLED_MINUTES} else 0 end)`,
      waitedJobs: sql<number>`sum(${waited})`,
      waitedMs: sql<number>`sum(case when ${waited} then ${waitMs} else 0 end)`,
      runnerFailedJobs: sql<number>`sum(${runnerFailed})`,
      runnerFailedMs: sql<number>`sum(case when ${runnerFailed} then ${DURATION_MS} else 0 end)`,
      runnerFailedBilled: sql<number>`sum(case when ${runnerFailed} then ${BILLED_MINUTES} else 0 end)`,
      // The one machine every job ran on, if there was one.
      machineId: sql<string | null>`case when count(${timing.machineId}) = count(*)
        and min(${timing.machineId}) = max(${timing.machineId}) then min(${timing.machineId}) end`,
      // The job and its run, when grouped by job.
      jobId: sql<number>`min(${timing.id})`,
      runId: sql<number>`min(${timing.runId})`,
      runAttempt: sql<number>`min(${timing.runAttempt})`,
    })
    .from(timing)
    .leftJoin(run, and(eq(run.id, timing.runId), eq(run.runAttempt, timing.runAttempt)))
    .leftJoin(
      paths,
      and(
        eq(paths.repositoryId, run.repositoryId),
        eq(paths.pullRequestNumber, run.pullRequestNumber),
      ),
    )
    .where(
      and(
        eq(timing.installationId, installationId),
        gte(timing.completedAt, new Date(since)),
        RAN_ON_RUNNER,
        matching(scope.filter, '"workflow_run"'),
        perJob
          ? and(
              eq(timing.repositoryFullName, perJob),
              sql`(${isShort} or ${waited} or ${runnerFailed})`,
            )
          : undefined,
      ),
    )
    .groupBy(
      sql`1`,
      timing.repositoryId,
      timing.workflowName,
      timing.name,
      timing.labels,
      timing.runnerGroupName,
      person,
      run.headBranch,
      trigger,
      paths.areas,
      ...(perJob ? [timing.id] : []),
    );
  const breakdown = new DayBreakdown();
  const waits = new DayWaits();
  for (const row of found) {
    const at = Number(row.day);
    const perMinute = rate(scope, row.labels, row.runnerGroupName, row.repositoryId, at);
    const where = { day: at, repositoryId: row.repositoryId, repository: row.repository };
    const cost = row.billed * perMinute;
    const ref = perJob
      ? { runId: row.runId, runAttempt: row.runAttempt, jobId: row.jobId }
      : undefined;
    if (!ref) {
      rows.add({ ...where, signal: TOTAL, subject: "" }, row.jobs, row.runMs, cost);
      breakdown.add(where, row, { runs: Number(row.runs), runMs: Number(row.runMs), cost });
      if (row.waitedJobs) waits.add(where, row);
    } else if (row.waitedJobs) {
      // One job's wait: its own row, with no runner to name across jobs.
      const key = { ...where, signal: "queue-waits", subject: runnerSubject(row.labels) };
      rows.add(key, row.waitedJobs, row.waitedMs, 0, ref);
    }
    if (row.runnerFailedJobs) {
      rows.add(
        { ...where, signal: "runner-failures", subject: runnerSubject(row.labels) },
        row.runnerFailedJobs,
        row.runnerFailedMs,
        row.runnerFailedBilled * perMinute,
        ref,
      );
    }
    if (!perMinute || !row.shortJobs) continue;
    const unusedMs = row.shortBilled * 60_000 - row.shortRunMs;
    rows.add(
      {
        ...where,
        signal: "short-jobs",
        subject: jobSubject(row.workflow, row.job),
        workflowPath: row.workflowPath,
      },
      row.shortJobs,
      unusedMs,
      (unusedMs / 60_000) * perMinute,
      ref,
    );
  }
  breakdown.addTo(rows);
  waits.addTo(rows);
}

// queue-waits rows per day, repo and runs-on labels, with the runner they went to: the machine
// when every one of them ran on the same machine, or else the labels' environment.
class DayWaits {
  #groups = new Map<
    string,
    {
      key: RowKey;
      labels: string[];
      group: string | null;
      machines: Set<string | null>;
      jobs: number;
      ms: number;
    }
  >();

  add(
    where: { day: number; repositoryId: number; repository: string },
    row: {
      labels: string[];
      runnerGroupName: string | null;
      machineId: string | null;
      waitedJobs: number;
      waitedMs: number;
    },
  ) {
    const subject = runnerSubject(row.labels);
    const id = `${where.day}:${where.repositoryId}:${subject}`;
    const group = this.#groups.get(id) ?? {
      key: { ...where, signal: "queue-waits", subject },
      labels: row.labels,
      group: row.runnerGroupName,
      machines: new Set(),
      jobs: 0,
      ms: 0,
    };
    group.machines.add(row.machineId);
    group.jobs += Number(row.waitedJobs);
    group.ms += Number(row.waitedMs);
    this.#groups.set(id, group);
  }

  addTo(rows: Sink) {
    for (const { key, labels, group, machines, jobs, ms } of this.#groups.values()) {
      const machine = machines.size === 1 ? [...machines][0]! : null;
      rows.add({ ...key, runnerKey: environmentFor(labels, group, machine).key }, jobs, ms, 0);
    }
  }
}

type DaySums = { runs: number; runMs: number; cost: number };

// The Breakdown's rows for each day: logins, branches and triggers for the whole installation
// (repositoryId 0), and workflows and folders per repo; the repository view sums the workflows. A
// pull request run counts in full under each folder it changed, and a run without read files under
// none. Each day and view keeps its MAX_DAY_VALUES values with the most time; the rest, jobs whose
// run we never saw and pull requests with too many files to list share the empty subject.
class DayBreakdown {
  #groups = new Map<string, { key: Omit<RowKey, "subject">; values: Map<string, Value> }>();

  add(
    where: { day: number; repositoryId: number; repository: string },
    job: {
      workflow: string | null;
      workflowPath: string | null;
      areas: string[] | null;
    } & Record<"person" | "branch" | "trigger", string | null>,
    sums: DaySums,
  ) {
    for (const by of BREAKDOWNS) {
      const perRepo = by === "workflow" || by === "path";
      const key = perRepo
        ? { ...where, signal: `by-${by}` }
        : { day: where.day, repositoryId: 0, repository: "", signal: `by-${by}` };
      const id = `${key.day}:${key.signal}:${key.repositoryId}`;
      const group = this.#groups.get(id) ?? { key, values: new Map<string, Value>() };
      this.#groups.set(id, group);
      for (const subject of subjectsOf(by, job)) {
        const value = group.values.get(subject) ?? { path: null, runs: 0, runMs: 0, cost: 0 };
        group.values.set(subject, value);
        if (by === "workflow") value.path ??= job.workflowPath;
        value.runs += sums.runs;
        value.runMs += sums.runMs;
        value.cost += sums.cost;
      }
    }
  }

  addTo(rows: Sink) {
    for (const { key, values } of this.#groups.values()) {
      const ranked = [...values].sort(([, a], [, b]) => b.runMs - a.runMs);
      ranked.forEach(([subject, value], index) => {
        const kept = subject !== "" && index < MAX_DAY_VALUES;
        rows.add(
          { ...key, subject: kept ? subject : "", workflowPath: kept ? value.path : null },
          value.runs,
          value.runMs,
          value.cost,
        );
      });
    }
  }
}

type Value = DaySums & { path: string | null };

// The Breakdown values a job counts under in one view: every folder its pull request changed in
// the path view (none without read files, the rest's empty subject without listed ones).
function subjectsOf(
  by: (typeof BREAKDOWNS)[number],
  job: { areas: string[] | null } & Record<
    "person" | "workflow" | "branch" | "trigger",
    string | null
  >,
) {
  if (by !== "path") return [job[by] ?? ""];
  if (!job.areas) return [];
  return job.areas.length ? job.areas : [""];
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
  o.id as runId, o.run_attempt as runAttempt, j.id as jobId, j.labels as labels,
  j.runner_group_name as runnerGroupName, j.completed_at as completedAt`);

type RunJobRow = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  path: string | null;
  runId: number;
  runAttempt: number;
  jobId: number;
  labels: string;
  runnerGroupName: string | null;
  completedAt: number;
  runMs: number;
};

// Runs on a branch other than the default that GitHub didn't cancel though a newer run of the same
// workflow started on that branch before they finished. The time is each job's part after the
// newer run started: what a concurrency group with cancel-in-progress would have saved.
async function addSupersededRuns(scope: Scope) {
  const { db, installationId, since, filter } = scope;
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
        and o.head_branch != coalesce(o.default_branch, 'main') and ${matching(filter, "o")}
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
  const { db, installationId, since, filter } = scope;
  const found = await db.all<RunJobRow>(sql`
    select ${RUN_JOB_COLUMNS}, max(0, j.completed_at - j.started_at) as runMs
    from workflow_run o
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
    where o.installation_id = ${installationId} and o.github_updated_at >= ${since}
      and o.event = 'push' and o.run_attempt = 1 and j.completed_at >= ${since} and ${COUNTED_JOB}
      and ${matching(filter, "o")}
      and exists (
        select 1 from workflow_run q
        where q.repository_id = o.repository_id and q.head_sha = o.head_sha
          and q.event = 'pull_request' and ${SAME_WORKFLOW("o", "q")}
      )`);
  addRunJobs(scope, "same-commit", found, true);
}

// First attempts of push and pull_request runs in the window that match the filter, for the
// complexity signals.
const FIRST_RUNS = ({
  installationId,
  since,
  filter,
}: Scope) => sql`o.installation_id = ${installationId}
  and o.github_updated_at >= ${since} and o.event in ('push', 'pull_request')
  and o.run_attempt = 1 and ${matching(filter, "o")}`;

// Runs for pull requests that only changed docs (src/pull-request-paths.ts). A run whose files we
// haven't read counts when its commit or pull request title starts with docs: or docs(scope):, the
// Conventional Commits type for documentation. Workflows with "doc" in their name are left out,
// since building docs is their job.
async function addDocsRuns(scope: Scope) {
  const { db, since } = scope;
  const found = await db.all<RunJobRow>(sql`
    select ${RUN_JOB_COLUMNS}, max(0, j.completed_at - j.started_at) as runMs
    from workflow_run o
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
    left join pull_request_paths p on p.repository_id = o.repository_id
      and p.pull_request_number = o.pull_request_number
    where ${FIRST_RUNS(scope)} and j.completed_at >= ${since} and ${COUNTED_JOB}
      and coalesce(p.docs_only,
        lower(o.display_title) like 'docs:%' or lower(o.display_title) like 'docs(%')
      and lower(coalesce(o.workflow_name, '')) not like '%doc%'`);
  addRunJobs(scope, "docs-changes", found, true);
}

// Runs on a branch other than the default that started FANOUT_JOBS jobs or more, usually a full
// matrix. All their jobs count, since a smaller matrix before merge is what would save time.
async function addWideRuns(scope: Scope) {
  const { db, since } = scope;
  const found = await db.all<RunJobRow>(sql`
    with wide as materialized (
      select o.id, o.run_attempt from workflow_run o
      join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
      where ${FIRST_RUNS(scope)} and ${COUNTED_JOB}
        and o.head_branch != coalesce(o.default_branch, 'main')
      group by o.id, o.run_attempt having count(*) >= ${FANOUT_JOBS}
    )
    select ${RUN_JOB_COLUMNS}, max(0, j.completed_at - j.started_at) as runMs
    from wide w
    join workflow_run o on o.id = w.id and o.run_attempt = w.run_attempt
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
    where j.completed_at >= ${since} and ${COUNTED_JOB}`);
  addRunJobs(scope, "wide-fanout", found, true);
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
      { runId: job.runId, runAttempt: job.runAttempt, jobId: null },
    );
  }
}

// A job's runs-on labels as people wrote them: a routed job's rr-<route> label is left out.
function runnerSubject(labels: string[]) {
  const written = labels.filter((label) => routeIdFromLabels([label]) === null);
  return written.length ? written.join(", ") : "Routed jobs";
}

// A job signal's subject: "workflow › job".
function jobSubject(workflow: string | null, job: string) {
  return `${workflow ?? "Workflow"} › ${job}`;
}

// A job and its workflow, as the job signals read them.
type JobRow = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  job: string;
  path: string | null;
  runId: number;
  runAttempt: number;
  jobId: number;
};

// Adds one job to a job signal's row for its repo and "workflow › job".
function addJob(
  scope: Scope,
  signal: SignalId,
  at: number,
  job: JobRow,
  runMs: number,
  cost: number,
) {
  scope.rows.add(
    {
      day: at,
      signal,
      repositoryId: job.repositoryId,
      repository: job.repository,
      subject: jobSubject(job.workflow, job.job),
      workflowPath: job.path,
    },
    1,
    runMs,
    cost,
    { runId: job.runId, runAttempt: job.runAttempt, jobId: job.jobId },
  );
}

type SlowestJobRow = JobRow & { completedAt: number; aloneMs: number };

// Per run attempt, the job that finished last though it started before the next-to-last one
// finished: the slow branch of jobs that ran side by side. The time is how long the run kept
// going on that job alone. Jobs that wait for others (needs:) start after them, so they're left
// out; so are picks, which finish first.
async function addSlowestJobs(scope: Scope) {
  const { db, installationId, since, filter } = scope;
  const found = await db.all<SlowestJobRow>(sql`
    with ranked as (
      select ${timing.repositoryId} as repositoryId, ${timing.repositoryFullName} as repository,
        ${timing.workflowName} as workflow, ${timing.name} as job, ${timing.id} as jobId,
        ${timing.runId} as runId,
        ${timing.runAttempt} as runAttempt, ${timing.startedAt} as startedAt,
        ${timing.completedAt} as completedAt,
        row_number() over latest as rank, lead(${timing.completedAt}) over latest as nextAt
      from ${timing}
      where ${timing.installationId} = ${installationId} and ${timing.completedAt} >= ${since}
        and ${RAN_ON_RUNNER} and not ${PICK}
      window latest as (
        partition by ${timing.runId}, ${timing.runAttempt} order by ${timing.completedAt} desc
      )
    )
    select k.repositoryId, k.repository, k.workflow, k.job, r.workflow_path as path, k.runId,
      k.runAttempt, k.jobId, k.completedAt, k.completedAt - k.nextAt as aloneMs
    from ranked k
    left join workflow_run r on r.id = k.runId and r.run_attempt = k.runAttempt
    where k.rank = 1 and k.startedAt < k.nextAt and k.completedAt - k.nextAt >= ${SLOWEST_JOB_MS}
      and ${matching(filter, "r")}`);
  for (const job of found)
    addJob(scope, "slowest-job", utcDay(job.completedAt), job, job.aloneMs, 0);
}

// Jobs that failed (or timed out) in a step and passed on the run's next attempt, whether someone
// re-ran them or automatic retries did. Jobs their runner failed before any step are
// runner-failures instead. The time and cost are the failed attempt's. Starts from the window's
// re-run attempts, so only those runs' jobs are read (job_timing_run_idx).
async function addFlakyJobs(scope: Scope) {
  const { db, installationId, since, filter } = scope;
  const found = await db.all<
    JobRow & { labels: string; runnerGroupName: string | null; completedAt: number; runMs: number }
  >(sql`
    select j.repository_id as repositoryId, j.repository_full_name as repository,
      j.workflow_name as workflow, j.name as job, o.workflow_path as path, j.run_id as runId,
      j.run_attempt as runAttempt, j.id as jobId, j.labels as labels,
      j.runner_group_name as runnerGroupName, j.completed_at as completedAt,
      max(0, j.completed_at - j.started_at) as runMs
    from workflow_run o
    join job_timing p on p.run_id = o.id and p.run_attempt = o.run_attempt
      and p.conclusion = 'success'
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt - 1 and j.name = p.name
      and j.conclusion in ('failure', 'timed_out') and coalesce(j.ran_steps, 1) = 1
    where o.installation_id = ${installationId} and o.github_updated_at >= ${since}
      and o.run_attempt > 1 and ${COUNTED_JOB} and ${matching(filter, "o")}`);
  for (const job of found) {
    const at = utcDay(job.completedAt);
    const labels = JSON.parse(job.labels) as string[];
    const perMinute = rate(scope, labels, job.runnerGroupName, job.repositoryId, at);
    const billed = Math.max(1, Math.ceil(job.runMs / 60_000));
    addJob(scope, "flaky-jobs", at, job, job.runMs, billed * perMinute);
  }
}

// A signal_day row as it goes into the insert, less the installation.
type InsertRow = Omit<typeof day.$inferInsert, "installationId" | "day"> & { day: number };

type RowKey = Pick<InsertRow, "day" | "signal" | "repositoryId" | "subject"> & {
  repository: string;
  workflowPath?: string | null;
  runnerKey?: string | null;
};

/** One signal's row: a repo and its workflow, job or runner. */
export type SignalRowRef = { signal: SignalId; repository: string; subject: string };

/** A run attempt behind a signal row, and the job in it when the signal is about one job. */
type RunRef = { runId: number; runAttempt: number; jobId: number | null };

// Where the queries above add what they find: day rows, or one row's runs (signalRuns).
interface Sink {
  add(key: RowKey, count: number, runMs: number, cost: number, run?: RunRef): void;
}

// One installation's signal_day rows being summed, by their primary key. `wholeRange` sums each
// key's days into one row, for a filtered page, and leaves out days from `until` on.
class Rows implements Sink {
  #rows = new Map<string, InsertRow>();
  #wholeRange: boolean;
  #until: number;

  constructor({ wholeRange = false, until = Infinity } = {}) {
    this.#wholeRange = wholeRange;
    this.#until = until;
  }

  add(key: RowKey, count: number, runMs: number, cost: number) {
    if (key.day >= this.#until) return;
    const day = this.#wholeRange ? 0 : key.day;
    const id = `${day}:${key.signal}:${key.repositoryId}:${key.subject}`;
    const row = this.#rows.get(id) ?? {
      day: key.day,
      signal: key.signal,
      repositoryId: key.repositoryId,
      repositoryFullName: key.repository,
      subject: key.subject,
      workflowPath: key.workflowPath ?? null,
      runnerKey: key.runnerKey ?? null,
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
  /** On queue-waits rows, the runner's Job times environment key, for its panel. */
  runnerKey: string | null;
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

export interface BreakdownRow {
  /**
   * A login, workflow, branch, trigger (an event name, or "rerun"), folder (ROOT_AREA for files at
   * the root) or repository.
   */
  name: string;
  /** The workflow's or folder's repository, on workflow and path rows. */
  repository: string | null;
  workflowPath: string | null;
  runs: number;
  minutes: number;
  /** Estimated USD. */
  cost: number;
}

export interface Breakdown {
  /** The most time first, at most MAX_BREAKDOWN_ROWS. */
  rows: BreakdownRow[];
  /** Everything past those rows, and jobs whose run we never saw. */
  other: { runs: number; minutes: number; cost: number } | null;
}

export interface SignalsReport {
  days: number;
  /** Every counted job in the range, for the area summaries. */
  totals: { jobs: number; minutes: number; cost: number };
  /** Signals over the threshold, the most time first. */
  signals: Signal[];
  /**
   * Every counted job split by who started it, repo, workflow, branch and trigger, and pull request
   * runs by the folders they changed. Left out when the caller asks for signals only.
   */
  breakdown?: Record<BreakdownBy, Breakdown>;
  /** On a filtered page, the filter's minutes per day against the range before. */
  trend?: SignalTrend | null;
}

export interface SignalTrend {
  /** Job minutes per UTC day over the range, oldest first. */
  minutes: number[];
  /**
   * As many days of the range before (the same days of last month for this month), or null when no
   * rollup goes back that far.
   */
  previous: number[] | null;
}

/**
 * The workspace's signals over a range of whole UTC days (the last 30 by default). A signal shows
 * when it covers at least MIN_MINUTES and MIN_SHARE of every job's minutes. With `breakdown` false,
 * the Breakdown's rows aren't read at all. A `filter` narrows everything to its runs, worked out
 * from single jobs over at most the last liveDays(), and adds the filter's trend.
 */
export async function signalsReport(
  db: Db,
  workspace: { id: string; installationId: number | null },
  range?: DayRange,
  { breakdown = true, filter = {}, now = Date.now() }: ReportOptions = {},
): Promise<SignalsReport> {
  const filtered = isFiltered(filter);
  range ??= lastUtcDays(30, now);
  if (filtered) range = atMost(range, liveDays(), now);
  const days = dayCount(range);
  const { installationId } = workspace;
  if (installationId === null)
    return { ...summarize([], days, breakdown), ...(filtered && { trend: null }) };
  if (!filtered) {
    const found = await dayRows(db, installationId, range, breakdown);
    return summarize(found, days, breakdown);
  }
  const rows = new Rows({ wholeRange: true, until: range.end });
  const since = range.start;
  const [, trend] = await Promise.all([
    pricing(db, installationId, now).then((prices) =>
      addAll({ db, ...prices, rows, installationId, since, filter }),
    ),
    filterTrend(db, installationId, filter, range),
  ]);
  const found = rows.values().map((row) => ({
    ...row,
    repository: row.repositoryFullName,
    workflowPath: row.workflowPath ?? null,
    runnerKey: row.runnerKey ?? null,
  }));
  return { ...summarize(found, days, breakdown), trend };
}

type ReportOptions = { breakdown?: boolean; filter?: SignalFilter; now?: number };

const isFiltered = (filter: SignalFilter) => Object.values(filter).some(Boolean);

// One signal, total or Breakdown value summed over the range: a repo and subject's day rows.
type FoundRow = {
  signal: string;
  repository: string;
  subject: string;
  workflowPath: string | null;
  runnerKey: string | null;
  count: number;
  runMs: number;
  cost: number;
};

// The range's signal_day rows, summed per signal, repo and subject.
function dayRows(
  db: Db,
  installationId: number,
  { start, end }: DayRange,
  breakdown: boolean,
): Promise<FoundRow[]> {
  return db
    .select({
      signal: day.signal,
      repository: sql<string>`max(${day.repositoryFullName})`,
      subject: day.subject,
      workflowPath: sql<string | null>`max(${day.workflowPath})`,
      runnerKey: sql<string | null>`max(${day.runnerKey})`,
      count: sql<number>`sum(${day.count})`,
      runMs: sql<number>`sum(${day.runMs})`,
      cost: sql<number>`sum(${day.cost})`,
    })
    .from(day)
    .where(
      and(
        eq(day.installationId, installationId),
        gte(day.day, new Date(start)),
        lt(day.day, new Date(end)),
        breakdown ? undefined : notLike(day.signal, "by-%"),
      ),
    )
    .groupBy(day.signal, day.repositoryId, day.subject);
}

function summarize(found: FoundRow[], days: number, breakdown: boolean): SignalsReport {
  const totals = { jobs: 0, minutes: 0, cost: 0 };
  const bySignal = new Map<SignalId, Signal>();
  const breakdowns = new Breakdowns();
  for (const row of found) {
    const minutes = Number(row.runMs) / 60_000;
    const cost = Number(row.cost);
    if (row.signal === TOTAL) {
      totals.jobs += Number(row.count);
      totals.minutes += minutes;
      totals.cost += cost;
      continue;
    }
    const by = BREAKDOWNS.find((view) => row.signal === `by-${view}`);
    if (by) {
      if (breakdown) breakdowns.add(by, row, { runs: Number(row.count), minutes, cost });
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
      runnerKey: row.runnerKey,
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
      ...rounded(signal),
      rows: signal.rows
        .filter((row) => row.minutes >= MIN_ROW_MINUTES)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, MAX_ROWS)
        .map(rounded),
    }))
    .sort((a, b) => b.minutes - a.minutes);
  return {
    days,
    totals: rounded(totals),
    signals,
    ...(breakdown && { breakdown: breakdowns.report() }),
  };
}

// The Breakdown's day rows that hold a filter's jobs: a person, branch or trigger, a repo's
// workflows (one of them, with a workflow) or one of its folders. Null for a filter on more than
// that, since each view's rows are kept apart.
function trendRows(filter: SignalFilter) {
  const { repository, workflow, path, ...rest } = filter;
  const others = Object.entries(rest).filter(([, value]) => value);
  if (repository || workflow || path) {
    if (others.length || (workflow && path)) return null;
    const subject = path ?? workflow;
    return and(
      eq(day.signal, path ? "by-path" : "by-workflow"),
      repository ? eq(day.repositoryFullName, repository) : undefined,
      subject ? eq(day.subject, subject) : undefined,
    );
  }
  if (others.length !== 1) return null;
  const [by, value] = others[0]!;
  return and(eq(day.signal, `by-${by}`), eq(day.subject, value!));
}

// The filter's minutes per day over the range and as many days from its prior start, from the
// hourly rollup so the range before can reach past single jobs. A day that kept the filter's value
// among the rest (MAX_DAY_VALUES) counts low.
async function filterTrend(
  db: Db,
  installationId: number,
  filter: SignalFilter,
  range: DayRange,
): Promise<SignalTrend | null> {
  const rows = trendRows(filter);
  if (!rows) return null;
  const { start, end, priorStart: before } = range;
  const days = dayCount(range);
  const [found, [rolledUpBefore]] = await Promise.all([
    db
      .select({ day: day.day, runMs: sql<number>`sum(${day.runMs})` })
      .from(day)
      .where(
        and(
          eq(day.installationId, installationId),
          gte(day.day, new Date(before)),
          lt(day.day, new Date(end)),
          rows,
        ),
      )
      .groupBy(day.day),
    // Whether any day before the range was rolled up, so an empty one there means no jobs.
    db
      .select({ one: sql`1` })
      .from(day)
      .where(and(eq(day.installationId, installationId), lt(day.day, new Date(start))))
      .limit(1),
  ]);
  const minutes = Array<number>(days).fill(0);
  const previous = Array<number>(days).fill(0);
  for (const row of found) {
    const at = row.day.getTime();
    const series = at < start ? previous : minutes;
    const index = Math.round((at < start ? at - before : at - start) / DAY_MS);
    if (index >= 0 && index < days) series[index] = Math.round(Number(row.runMs) / 60_000);
  }
  return { minutes, previous: rolledUpBefore ? previous : null };
}

/** One run attempt behind a signal row. Times are epoch ms; money is USD. */
export interface SignalRun {
  repositoryId: number;
  repository: string;
  runId: number;
  runAttempt: number;
  /** The job the signal is about, on job signals, to open in the run. */
  jobId: number | null;
  workflow: string | null;
  title: string | null;
  event: string | null;
  branch: string | null;
  sha: string | null;
  actor: string | null;
  conclusion: string | null;
  startedAt: number | null;
  /** The part of the run the signal counts, as on its row. */
  runMs: number;
  cost: number;
}

export interface SignalRunsReport {
  days: number;
  /** Newest first, at most MAX_RUNS. */
  runs: SignalRun[];
  /** Every run behind the row, listed or not. */
  total: number;
}

// Runs a signal row lists.
const MAX_RUNS = 50;

// Which queries find each signal, for signalRuns.
const FINDERS: Record<SignalId, (scope: Scope) => Promise<void>> = {
  "no-concurrency": addSupersededRuns,
  "same-commit": addSameCommitRuns,
  "short-jobs": addJobs,
  "queue-waits": addJobs,
  "runner-failures": addJobs,
  "slowest-job": addSlowestJobs,
  "flaky-jobs": addFlakyJobs,
  "docs-changes": addDocsRuns,
  "wide-fanout": addWideRuns,
};

/**
 * The runs behind one signal row (a repo and subject) over a range (at most the last liveDays()),
 * within the page's filter: the same queries the rollup runs, kept to that row.
 */
export async function signalRuns(
  db: Db,
  installationId: number | null,
  row: SignalRowRef,
  range: DayRange,
  { filter = {}, now = Date.now() }: { filter?: SignalFilter; now?: number } = {},
): Promise<SignalRunsReport> {
  range = atMost(range, liveDays(), now);
  const days = dayCount(range);
  if (installationId === null) return { days, runs: [], total: 0 };
  const hits = new RunHits(row, range.end);
  await FINDERS[row.signal]({
    db,
    ...(await pricing(db, installationId, now)),
    rows: hits,
    installationId,
    since: range.start,
    // Narrowed to the row's repo: run signals by its runs, job signals by their jobs.
    filter: FINDERS[row.signal] === addJobs ? filter : { ...filter, repository: row.repository },
    perJob: row.repository,
  });
  const all = hits.runs();
  const listed = all.slice(0, MAX_RUNS);
  const found = listed.length
    ? await db
        .select()
        .from(run)
        .where(
          and(
            eq(run.installationId, installationId),
            inArray(
              run.id,
              listed.map((hit) => hit.runId),
            ),
          ),
        )
    : [];
  const byAttempt = new Map(found.map((each) => [`${each.id}:${each.runAttempt}`, each]));
  const runs = listed.map((hit): SignalRun => {
    const seen = byAttempt.get(`${hit.runId}:${hit.runAttempt}`);
    return {
      repositoryId: hit.repositoryId,
      repository: row.repository,
      runId: hit.runId,
      runAttempt: hit.runAttempt,
      jobId: hit.jobId,
      workflow: seen?.workflowName ?? null,
      title: seen?.displayTitle ?? null,
      event: seen?.event ?? null,
      branch: seen?.headBranch ?? null,
      sha: seen?.headSha ?? null,
      actor: seen ? (seen.startedByLogin ?? seen.actorLogin) : null,
      conclusion: seen?.conclusion ?? null,
      startedAt: seen?.runStartedAt?.getTime() ?? null,
      runMs: Math.round(hit.runMs),
      cost: cents(hit.cost),
    };
  });
  return { days, runs, total: all.length };
}

type RunHit = RunRef & { repositoryId: number; runMs: number; cost: number };

// The run attempts behind one signal row, as the queries add them, before the day `until`.
class RunHits implements Sink {
  #runs = new Map<string, RunHit>();
  #row: SignalRowRef;
  #until: number;

  constructor(row: SignalRowRef, until: number) {
    this.#row = row;
    this.#until = until;
  }

  add(key: RowKey, _count: number, runMs: number, cost: number, ref?: RunRef) {
    const { signal, repository, subject } = this.#row;
    if (
      !ref ||
      key.day >= this.#until ||
      key.signal !== signal ||
      key.repository !== repository ||
      key.subject !== subject
    )
      return;
    const id = `${ref.runId}:${ref.runAttempt}`;
    const hit = this.#runs.get(id) ?? {
      ...ref,
      repositoryId: key.repositoryId,
      runMs: 0,
      cost: 0,
    };
    hit.jobId ??= ref.jobId;
    hit.runMs += Number(runMs);
    hit.cost += cost;
    this.#runs.set(id, hit);
  }

  /** Newest first: GitHub's run ids only grow. */
  runs() {
    return [...this.#runs.values()].sort(
      (a, b) => b.runId - a.runId || b.runAttempt - a.runAttempt,
    );
  }
}

type BreakdownSums = { runs: number; minutes: number; cost: number };
type BreakdownName = Pick<BreakdownRow, "name" | "repository" | "workflowPath">;

// The Breakdown's views summed from signal_day rows over the range. Logins, branches and triggers
// are stored for the whole installation; workflows and folders per repo, and the repository view
// sums the workflows. Empty names are the rest of a day's values, and go to `other`.
class Breakdowns {
  #views = new Map<BreakdownBy, Map<string, BreakdownRow>>(
    [...BREAKDOWNS, "repository" as const].map((by) => [by, new Map()]),
  );

  add(
    by: (typeof BREAKDOWNS)[number],
    row: { repository: string; subject: string; workflowPath: string | null },
    sums: BreakdownSums,
  ) {
    const name = row.subject;
    if (by !== "workflow" && by !== "path") {
      this.#sum(by, name, { name, repository: null, workflowPath: null }, sums);
      return;
    }
    const { repository, workflowPath } = row;
    this.#sum(by, `${repository}:${name}`, { name, repository, workflowPath }, sums);
    if (by === "path") return;
    this.#sum(
      "repository",
      repository,
      { name: repository, repository: null, workflowPath: null },
      sums,
    );
  }

  #sum(by: BreakdownBy, id: string, name: BreakdownName, sums: BreakdownSums) {
    const view = this.#views.get(by)!;
    const found = view.get(id) ?? { ...name, runs: 0, minutes: 0, cost: 0 };
    found.workflowPath ??= name.workflowPath;
    found.runs += sums.runs;
    found.minutes += sums.minutes;
    found.cost += sums.cost;
    view.set(id, found);
  }

  report() {
    const entries = [...this.#views].map(([by, view]) => {
      const rows = [...view.values()].sort((a, b) => b.minutes - a.minutes);
      const named = rows.filter((row) => row.name !== "");
      const rest = [...named.slice(MAX_BREAKDOWN_ROWS), ...rows.filter((row) => row.name === "")];
      const other = rest.reduce(
        (sum, row) => ({
          runs: sum.runs + row.runs,
          minutes: sum.minutes + row.minutes,
          cost: sum.cost + row.cost,
        }),
        { runs: 0, minutes: 0, cost: 0 },
      );
      const breakdown: Breakdown = {
        rows: named.slice(0, MAX_BREAKDOWN_ROWS).map(rounded),
        other: rest.length ? rounded(other) : null,
      };
      return [by, breakdown] as const;
    });
    return Object.fromEntries(entries) as Record<BreakdownBy, Breakdown>;
  }
}

// Minutes to the whole minute and USD to the cent, for the page.
function rounded<T extends { minutes: number; cost: number }>(sums: T): T {
  return { ...sums, minutes: Math.round(sums.minutes), cost: cents(sums.cost) };
}

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}
