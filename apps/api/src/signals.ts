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
 *
 * The same rows hold the page's Breakdown: every counted job by who started its run, its workflow,
 * branch and trigger.
 */
import { and, eq, exists, gte, isNull, sql } from "drizzle-orm";
import type { PriceBook } from "@relayrunner/providers";
import { type Db, createDb, prepare, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { enqueueInstallationTasks } from "./installation-tasks.ts";
import { PICK, RAN_ON_RUNNER } from "./job-times.ts";
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
  // Runs for commits or pull requests titled as docs changes (docs: in Conventional Commits).
  "docs-changes": "complexity",
  // Runs on a branch other than the default that started FANOUT_JOBS jobs or more.
  "wide-fanout": "complexity",
} as const satisfies Record<string, SignalArea>;

export type SignalId = keyof typeof SIGNALS;

/** How the Breakdown splits every counted job. The repository view sums any of the others. */
export const BREAKDOWNS = ["person", "workflow", "branch", "trigger"] as const;
export type BreakdownBy = (typeof BREAKDOWNS)[number] | "repository";

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
  const rows = new Rows();
  const scope = { db, book, rows, privacy, installationId, since };
  await Promise.all([
    addJobs(scope),
    addSupersededRuns(scope),
    addSameCommitRuns(scope),
    addSlowestJobs(scope),
    addFlakyJobs(scope),
    addDocsRuns(scope),
    addWideRuns(scope),
  ]);

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
    subject, workflow_path, count, run_ms, cost)
  select ?1, value ->> 'day', value ->> 'signal', value ->> 'repositoryId',
    value ->> 'repositoryFullName', value ->> 'subject', value ->> 'workflowPath',
    value ->> 'count', value ->> 'runMs', value ->> 'cost'
  from json_each(?2)`;

// Rows per insert statement: well under D1's limit on one parameter's size.
const ROWS_PER_INSERT = 2000;

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

// Every counted job (the usage report's filter) into the totals and the Breakdown; the short ones
// on a billed runner into short-jobs, with the unused part of their last minute as its time and
// cost; and the ones that waited for a runner into queue-waits, with the wait as its time. Picks
// (runs-on: relayrunner) only wait for RelayRunner, so they don't count as waiting.
async function addJobs(scope: Scope) {
  const { db, rows, installationId, since } = scope;
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
      person,
      run.headBranch,
      trigger,
    );
  const breakdown = new DayBreakdown();
  for (const row of found) {
    const at = Number(row.day);
    const perMinute = rate(scope, row.labels, row.runnerGroupName, row.repositoryId, at);
    const where = { day: at, repositoryId: row.repositoryId, repository: row.repository };
    const cost = row.billed * perMinute;
    rows.add({ ...where, signal: TOTAL, subject: "" }, row.jobs, row.runMs, cost);
    breakdown.add(where, row, { runs: Number(row.runs), runMs: Number(row.runMs), cost });
    if (row.waitedJobs) {
      rows.add(
        { ...where, signal: "queue-waits", subject: runnerSubject(row.labels) },
        row.waitedJobs,
        row.waitedMs,
        0,
      );
    }
    if (row.runnerFailedJobs) {
      rows.add(
        { ...where, signal: "runner-failures", subject: runnerSubject(row.labels) },
        row.runnerFailedJobs,
        row.runnerFailedMs,
        row.runnerFailedBilled * perMinute,
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
    );
  }
  breakdown.addTo(rows);
}

type DaySums = { runs: number; runMs: number; cost: number };

// The Breakdown's rows for each day: logins, branches and triggers for the whole installation
// (repositoryId 0), and workflows per repo, which the repository view sums. Each day and view
// keeps its MAX_DAY_VALUES values with the most time; the rest, and jobs whose run we never saw,
// share the empty subject.
class DayBreakdown {
  #groups = new Map<string, { key: Omit<RowKey, "subject">; values: Map<string, Value> }>();

  add(
    where: { day: number; repositoryId: number; repository: string },
    job: { workflow: string | null; workflowPath: string | null } & Record<
      "person" | "branch" | "trigger",
      string | null
    >,
    sums: DaySums,
  ) {
    for (const by of BREAKDOWNS) {
      const perRepo = by === "workflow";
      const key = perRepo
        ? { ...where, signal: `by-${by}` }
        : { day: where.day, repositoryId: 0, repository: "", signal: `by-${by}` };
      const id = `${key.day}:${key.signal}:${key.repositoryId}`;
      const group = this.#groups.get(id) ?? { key, values: new Map<string, Value>() };
      this.#groups.set(id, group);
      const subject = job[by] ?? "";
      const value = group.values.get(subject) ?? { path: null, runs: 0, runMs: 0, cost: 0 };
      group.values.set(subject, value);
      if (perRepo) value.path ??= job.workflowPath;
      value.runs += sums.runs;
      value.runMs += sums.runMs;
      value.cost += sums.cost;
    }
  }

  addTo(rows: Rows) {
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

// First attempts of push and pull_request runs in the window, for the complexity signals.
const FIRST_RUNS = (
  installationId: number,
  since: number,
) => sql`o.installation_id = ${installationId}
  and o.github_updated_at >= ${since} and o.event in ('push', 'pull_request')
  and o.run_attempt = 1`;

// Runs whose commit or pull request title starts with docs: or docs(scope):, the Conventional
// Commits type for documentation. Workflows with "doc" in their name are left out, since building
// docs is their job.
async function addDocsRuns(scope: Scope) {
  const { db, installationId, since } = scope;
  const found = await db.all<RunJobRow>(sql`
    select ${RUN_JOB_COLUMNS}, max(0, j.completed_at - j.started_at) as runMs
    from workflow_run o
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
    where ${FIRST_RUNS(installationId, since)} and j.completed_at >= ${since} and ${COUNTED_JOB}
      and (lower(o.display_title) like 'docs:%' or lower(o.display_title) like 'docs(%')
      and lower(coalesce(o.workflow_name, '')) not like '%doc%'`);
  addRunJobs(scope, "docs-changes", found, true);
}

// Runs on a branch other than the default that started FANOUT_JOBS jobs or more, usually a full
// matrix. All their jobs count, since a smaller matrix before merge is what would save time.
async function addWideRuns(scope: Scope) {
  const { db, installationId, since } = scope;
  const found = await db.all<RunJobRow>(sql`
    with wide as materialized (
      select o.id, o.run_attempt from workflow_run o
      join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt
      where ${FIRST_RUNS(installationId, since)} and ${COUNTED_JOB}
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
  );
}

type SlowestJobRow = JobRow & { completedAt: number; aloneMs: number };

// Per run attempt, the job that finished last though it started before the next-to-last one
// finished: the slow branch of jobs that ran side by side. The time is how long the run kept
// going on that job alone. Jobs that wait for others (needs:) start after them, so they're left
// out; so are picks, which finish first.
async function addSlowestJobs(scope: Scope) {
  const { db, installationId, since } = scope;
  const found = await db.all<SlowestJobRow>(sql`
    with ranked as (
      select ${timing.repositoryId} as repositoryId, ${timing.repositoryFullName} as repository,
        ${timing.workflowName} as workflow, ${timing.name} as job, ${timing.runId} as runId,
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
    select k.repositoryId, k.repository, k.workflow, k.job, r.workflow_path as path,
      k.completedAt, k.completedAt - k.nextAt as aloneMs
    from ranked k
    left join workflow_run r on r.id = k.runId and r.run_attempt = k.runAttempt
    where k.rank = 1 and k.startedAt < k.nextAt and k.completedAt - k.nextAt >= ${SLOWEST_JOB_MS}`);
  for (const job of found)
    addJob(scope, "slowest-job", utcDay(job.completedAt), job, job.aloneMs, 0);
}

// Jobs that failed (or timed out) in a step and passed on the run's next attempt, whether someone
// re-ran them or automatic retries did. Jobs their runner failed before any step are
// runner-failures instead. The time and cost are the failed attempt's. Starts from the window's
// re-run attempts, so only those runs' jobs are read (job_timing_run_idx).
async function addFlakyJobs(scope: Scope) {
  const { db, installationId, since } = scope;
  const found = await db.all<
    JobRow & { labels: string; runnerGroupName: string | null; completedAt: number; runMs: number }
  >(sql`
    select j.repository_id as repositoryId, j.repository_full_name as repository,
      j.workflow_name as workflow, j.name as job, o.workflow_path as path, j.labels as labels,
      j.runner_group_name as runnerGroupName, j.completed_at as completedAt,
      max(0, j.completed_at - j.started_at) as runMs
    from workflow_run o
    join job_timing p on p.run_id = o.id and p.run_attempt = o.run_attempt
      and p.conclusion = 'success'
    join job_timing j on j.run_id = o.id and j.run_attempt = o.run_attempt - 1 and j.name = p.name
      and j.conclusion in ('failure', 'timed_out') and coalesce(j.ran_steps, 1) = 1
    where o.installation_id = ${installationId} and o.github_updated_at >= ${since}
      and o.run_attempt > 1 and ${COUNTED_JOB}`);
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
};

// One installation's signal_day rows being summed, by their primary key.
class Rows {
  #rows = new Map<string, InsertRow>();

  add(key: RowKey, count: number, runMs: number, cost: number) {
    const id = `${key.day}:${key.signal}:${key.repositoryId}:${key.subject}`;
    const row = this.#rows.get(id) ?? {
      day: key.day,
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

export interface BreakdownRow {
  /** A login, workflow, branch, trigger (an event name, or "rerun") or repository. */
  name: string;
  /** The workflow's repository, on workflow rows. */
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
  /** Every counted job split by who started it, repo, workflow, branch and trigger. */
  breakdown: Record<BreakdownBy, Breakdown>;
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
      breakdowns.add(by, row, { runs: Number(row.count), minutes, cost });
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
    breakdown: breakdowns.report(),
  };
}

type BreakdownSums = { runs: number; minutes: number; cost: number };
type BreakdownName = Pick<BreakdownRow, "name" | "repository" | "workflowPath">;

// The Breakdown's views summed from signal_day rows over the range. Logins, branches and triggers
// are stored for the whole installation; workflows per repo, which the repository view sums.
// Empty names are the rest of a day's values, and go to `other`.
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
    if (by !== "workflow") {
      this.#sum(by, name, { name, repository: null, workflowPath: null }, sums);
      return;
    }
    const { repository, workflowPath } = row;
    this.#sum(by, `${repository}:${name}`, { name, repository, workflowPath }, sums);
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
