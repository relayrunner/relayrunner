// Runs: each workflow run in the workspace's repos, newest first, for the dashboard's History page
// (Workflows), plus each workflow's usual time for Performance (Workflows) and a flat list of jobs
// for History (Jobs). A run's title, trigger and status come from workflow_run webhooks (stored
// here); its jobs, wall time and runners come from job_timing (src/job-timings.ts), so runs from
// before the App sent workflow_run still show, with less detail. A run's detail also lists the jobs
// still going.
//
// Database cost: the run list and workflow times are two statements, run together, each a range of
// an installation index (job_timing_installation_idx, workflow_run_installation_idx) over the
// window, never a scan. The job list is one range of job_timing_installation_idx, newest first and
// capped. One run's jobs are a range of job_timing_run_idx.
import { purgeBefore } from "./purge.ts";
import { environmentFor, nameMachines } from "./environments.ts";
import { inWorkspace, PICK, RAN_ON_RUNNER } from "./job-sql.ts";
import type { RouteWalk } from "@relayrunner/activity";
import type { PerformanceReport } from "@relayrunner/api-types";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { findInstallation } from "./installations.ts";
import {
  type Environment,
  FEW_RUNS,
  jobTimesReport,
  quantile,
  type Stat,
  statOf,
  type TypicalTime,
  typicalJobTimes,
  typicalKey,
} from "./job-times.ts";
import { DAY_MS, RAW_RETENTION_DAYS } from "./time.ts";
import { hasTrend, lastDays, type ReportWindow, type Window, windowDays } from "./report-window.ts";
import { parseDate } from "./jobs.ts";
import { jobKey, picksForJobs } from "./route-decisions.ts";
import { workflowCosts } from "./workflow-compare.ts";

type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;

const table = schema.workflowRun;
const timing = schema.jobTiming;

/** The Runs list's default window. A workflow's usual time is the p90 of its successful runs in it. */
const USUAL_DAYS = 14;
/** Most runs one list returns. */
const RUN_LIMIT = 200;

/**
 * Stores one workflow_run delivery. Deliveries are unordered, so a row only takes one GitHub
 * updated later; a redelivery is a no-op. Skipped when the installation has no row yet.
 */
export async function recordWorkflowRun(db: Db, message: WorkflowRunMessage): Promise<boolean> {
  const { installationId, run, repository } = message;
  if (!installationId || !(await findInstallation(db, installationId))) return false;
  const values = {
    installationId,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    workflowName: run.workflowName,
    workflowId: run.workflowId,
    workflowPath: run.workflowPath,
    defaultBranch: run.defaultBranch,
    displayTitle: run.displayTitle,
    event: run.event,
    actorLogin: run.actorLogin,
    startedById: run.startedBy?.id ?? null,
    startedByLogin: run.startedBy?.login ?? null,
    triggeredById: run.triggeredBy?.id ?? null,
    triggeredByLogin: run.triggeredBy?.login ?? null,
    headBranch: run.headBranch,
    headSha: run.headSha,
    pullRequestNumber: run.pullRequestNumber,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.htmlUrl,
    runStartedAt: parseDate(run.runStartedAt),
    githubUpdatedAt: parseDate(run.updatedAt) ?? new Date(message.receivedAt),
  };
  await db
    .insert(table)
    .values({ id: run.id, runAttempt: run.runAttempt, ...values })
    .onConflictDoUpdate({
      target: [table.id, table.runAttempt],
      set: { ...values, updatedAt: new Date() },
      setWhere: sql`excluded.github_updated_at >= ${table.githubUpdatedAt}`,
    });
  return true;
}

/**
 * Deletes runs last updated before job_timing keeps its jobs' own rows (RAW_RETENTION_DAYS), the
 * furthest back the Runs page could show their jobs. Returns how many rows went.
 */
export function purgeOldWorkflowRuns(db: Db, now = Date.now()): Promise<number> {
  return purgeBefore(db, table, table.githubUpdatedAt, new Date(now - RAW_RETENTION_DAYS * DAY_MS));
}

type RunStatus = "queued" | "in_progress" | "completed";

export interface Run {
  repositoryId: number;
  repository: string;
  runId: number;
  runAttempt: number;
  workflow: string | null;
  /** The commit or PR title. Null for runs from before workflow_run was stored. */
  title: string | null;
  /** push, pull_request, schedule, ... Null when only job data is known. */
  event: string | null;
  actor: string | null;
  /** The commit the run is for. Null when only job data is known. */
  sha: string | null;
  branch: string | null;
  pullRequest: number | null;
  url: string;
  status: RunStatus;
  /** GitHub's run conclusion, or one worked out from the jobs. Null until it completes. */
  conclusion: string | null;
  startedAt: number | null;
  /** When the run last changed: its last job finished, or GitHub last updated it. */
  updatedAt: number;
  /** First job queued (or the run started) to last job finished. Null until it completes. */
  wallMs: number | null;
  /** Where its jobs ran, as environment keys. */
  environments: string[];
  /** A RelayRunner pick chose its runners. */
  routed: boolean;
  /** The workflow's usual time: the p90 of its successful runs, with FEW_RUNS+ of them. */
  usualMs: number | null;
  /** For a cancelled run, the newer run on the same branch that it was cancelled for. */
  supersededBy: { runId: number; runAttempt: number } | null;
}

export interface RunsReport {
  /** Days the usual times come from: the window, or the USUAL_DAYS up to its end if longer. */
  days: number;
  /** Environments the runs used, most used first. */
  environments: Environment[];
  runs: Run[];
  /** More runs fell in the window than RUN_LIMIT. */
  truncated: boolean;
}

interface JobGroup {
  repository_id: number;
  repository: string;
  run_id: number;
  run_attempt: number;
  workflow_name: string | null;
  jobs: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  routed: number;
  first_queued: number | null;
  last_completed: number | null;
  /** Each environment that ran a job, `labels␟group␟machine␞`, joined by commas. */
  envs: string | null;
  /** Each job's `started:completed` on a runner, joined by commas. */
  spans: string | null;
}

/** The finished jobs of each run in the window, grouped by run: a range of the installation index. */
function jobGroupsQuery(workspaceId: string, { from, to }: Window) {
  return sql`
    select ${timing.repositoryId} as repository_id, min(${timing.repositoryFullName}) as repository,
      ${timing.runId} as run_id, ${timing.runAttempt} as run_attempt,
      min(${timing.workflowName}) as workflow_name,
      sum(not ${PICK}) as jobs,
      sum(${timing.conclusion} = 'failure') as failed,
      sum(${timing.conclusion} = 'timed_out') as timed_out,
      sum(${timing.conclusion} = 'cancelled') as cancelled,
      max(${PICK}) as routed,
      min(coalesce(${timing.queuedAt}, ${timing.startedAt})) as first_queued,
      max(${timing.completedAt}) as last_completed,
      group_concat(distinct case when not ${PICK} and ${RAN_ON_RUNNER} then ${timing.labels}
        || char(31) || coalesce(${timing.runnerGroupName}, '')
        || char(31) || coalesce(${timing.machineId}, '') || char(30) end) as envs,
      group_concat(case when not ${PICK} and ${timing.startedAt} is not null
        then ${timing.startedAt} || ':' || ${timing.completedAt} end) as spans
    from ${timing}
    where ${inWorkspace(workspaceId)} and ${timing.completedAt} >= ${from}
      and ${timing.completedAt} < ${to}
    group by ${timing.repositoryId}, ${timing.runId}, ${timing.runAttempt}`;
}

/** `labels␟group␟machine␞,...` → each environment's raw `labels␟group␟machine`. */
export function splitEnvs(text: string | null): string[] {
  if (!text) return [];
  return text
    .split("\u001e")
    .map((part) => part.replace(/^,/, ""))
    .filter(Boolean);
}

/**
 * How much of a run's wall time no job was running: before the first job started and between jobs,
 * mostly waiting for a runner. Jobs running at the same time count once. `spans` is
 * JobGroup.spans.
 */
export function waitingMs(start: number, end: number, spans: string | null): number {
  const intervals = (spans ? spans.split(",") : [])
    .map((span) => span.split(":").map(Number))
    .map(([from, to]) => [Math.max(start, from), Math.min(end, to)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let running = 0;
  let reach = start;
  for (const [from, to] of intervals) {
    if (to <= reach) continue;
    running += to - Math.max(from, reach);
    reach = to;
  }
  return Math.max(0, end - start - running);
}

type JobConclusions = Pick<JobGroup, "failed" | "timed_out" | "cancelled">;

function conclusionOfJobs(group: JobConclusions) {
  if (Number(group.failed)) return "failure";
  if (Number(group.timed_out)) return "timed_out";
  if (Number(group.cancelled)) return "cancelled";
  return "success";
}

/**
 * A finished run's result: GitHub's, or one worked out from its jobs. GitHub ends a run whose job
 * hit its `timeout-minutes` as cancelled, so a job that timed out makes the run timed out too.
 */
function runConclusion(github: string | null | undefined, jobs: JobConclusions | undefined) {
  if (github === "cancelled" && Number(jobs?.timed_out)) return "timed_out";
  return github ?? (jobs ? conclusionOfJobs(jobs) : null);
}

function runStatus(status: string | undefined): RunStatus {
  if (status === undefined || status === "completed") return "completed";
  return status === "in_progress" ? "in_progress" : "queued";
}

const runKey = (repositoryId: number, runId: number, runAttempt: number) =>
  `${repositoryId}:${runId}:${runAttempt}`;

type WorkflowRunRow = typeof table.$inferSelect;

/** A run's fields that come from its workflow_run row, when there is one. */
function runFields(
  row: WorkflowRunRow | undefined,
  run: { repository: string; runId: number; runAttempt: number },
) {
  return {
    repository: run.repository,
    title: row?.displayTitle ?? null,
    event: row?.event ?? null,
    actor: row?.actorLogin ?? null,
    sha: row?.headSha ?? null,
    branch: row?.headBranch ?? null,
    pullRequest: row?.pullRequestNumber ?? null,
    url:
      row?.htmlUrl ??
      `https://github.com/${run.repository}/actions/runs/${run.runId}/attempts/${run.runAttempt}`,
  };
}

/** `repositoryId␟workflow name`: a workflow, as the run list and job times both key it. */
export const workflowKey = (repositoryId: number, workflow: string | null) =>
  `${repositoryId}\u001f${workflow ?? ""}`;

/** Every run that changed in the window: its status, result and wall time, newest first. */
async function runSummaries(db: Db, workspaceId: string, window: Window) {
  const [groups, rows] = await Promise.all([
    db.all<JobGroup>(jobGroupsQuery(workspaceId, window)),
    db
      .select()
      .from(table)
      .where(
        and(
          inWorkspace(workspaceId, table.installationId),
          sql`${table.githubUpdatedAt} >= ${window.from}`,
          sql`${table.githubUpdatedAt} < ${window.to}`,
        ),
      ),
  ]);

  // First the cheap parts of every run: enough for the usual times and the order.
  const sources = new Map<string, { group?: JobGroup; row?: WorkflowRunRow }>();
  for (const group of groups)
    sources.set(runKey(group.repository_id, group.run_id, group.run_attempt), { group });
  for (const row of rows) {
    const key = runKey(row.repositoryId, row.id, row.runAttempt);
    sources.set(key, { ...sources.get(key), row });
  }
  const summaries = [];
  for (const { group, row } of sources.values()) {
    // A run seen only as a pick (its jobs still running, no workflow_run yet) has nothing to show.
    if (!row && !Number(group?.jobs)) continue;
    const status = runStatus(row?.status);
    const startedAt = row?.runStartedAt?.getTime() ?? group?.first_queued ?? null;
    const completedAt =
      status === "completed"
        ? (group?.last_completed ?? row?.githubUpdatedAt.getTime() ?? null)
        : null;
    const summary = {
      group,
      row,
      status,
      startedAt,
      conclusion: status !== "completed" ? null : runConclusion(row?.conclusion, group),
      completedAt,
      wallMs:
        startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
      waitMs:
        startedAt !== null && completedAt !== null && group
          ? waitingMs(startedAt, completedAt, group.spans)
          : null,
      updatedAt: Math.max(group?.last_completed ?? 0, row?.githubUpdatedAt.getTime() ?? 0),
      workflow: workflowKey(
        row?.repositoryId ?? group?.repository_id ?? 0,
        row?.workflowName ?? group?.workflow_name ?? null,
      ),
    };
    summaries.push(summary);
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

type RunSummary = Awaited<ReturnType<typeof runSummaries>>[number];

// How long after a run ended a newer run's start still counts as what cancelled it, for clock skew
// between GitHub's run and job times.
const SUPERSEDE_SLACK_MS = 60_000;

/**
 * For each of `targets` that was cancelled, the newer run of the same workflow on the same branch
 * that started before it ended: the run a concurrency group with cancel-in-progress cancelled it
 * for. Someone cancelling a run just after pushing again reads the same, which is close enough.
 */
export function supersedingRuns(summaries: RunSummary[], targets: RunSummary[]) {
  const started = (summary: RunSummary) => summary.row?.runStartedAt?.getTime() ?? null;
  const branchKey = (summary: RunSummary) =>
    summary.row?.headBranch && started(summary) !== null
      ? `${summary.workflow}\u001f${summary.row.headBranch}`
      : null;
  const byBranch = Map.groupBy(summaries, branchKey);
  const found = new Map<RunSummary, { runId: number; runAttempt: number }>();
  for (const summary of targets) {
    const key = branchKey(summary);
    const start = started(summary);
    if (summary.conclusion !== "cancelled" || key === null || start === null) continue;
    if (summary.completedAt === null) continue;
    const ended = summary.completedAt + SUPERSEDE_SLACK_MS;
    let newer: RunSummary | undefined;
    for (const other of byBranch.get(key) ?? []) {
      const at = started(other)!;
      if (other.row!.id === summary.row!.id || at <= start || at > ended) continue;
      if (!newer || at < started(newer)!) newer = other;
    }
    if (newer) found.set(summary, { runId: newer.row!.id, runAttempt: newer.row!.runAttempt });
  }
  return found;
}

/** Each workflow's successful run times, by workflowKey, newest first. */
function successfulWalls(summaries: RunSummary[]) {
  const walls = new Map<string, RunSummary[]>();
  for (const summary of summaries) {
    if (summary.conclusion !== "success" || summary.wallMs === null) continue;
    const runs = walls.get(summary.workflow);
    if (runs) runs.push(summary);
    else walls.set(summary.workflow, [summary]);
  }
  return walls;
}

/**
 * The workspace's runs that changed in the window, newest first, at most RUN_LIMIT. With `only`,
 * just that workflow's runs, so a quiet one isn't crowded out of the limit by busier ones.
 */
export async function listRuns(
  db: Db,
  workspaceId: string,
  window: Window = lastDays(USUAL_DAYS),
  only?: { repository: string; workflow: string },
): Promise<RunsReport> {
  // Usual times come from at least USUAL_DAYS, so a short window still has enough runs.
  const read = { from: Math.min(window.from, window.to - USUAL_DAYS * DAY_MS), to: window.to };
  const all = await runSummaries(db, workspaceId, read);
  const summaries = all.filter(
    ({ updatedAt, row, group }) =>
      updatedAt >= window.from &&
      (!only ||
        ((row?.repositoryFullName ?? group?.repository) === only.repository &&
          (row?.workflowName ?? group?.workflow_name) === only.workflow)),
  );
  // Each workflow's usual time, from its successful runs over everything read.
  const usual = new Map<string, number | null>();
  for (const [workflow, runs] of successfulWalls(all))
    if (runs.length >= FEW_RUNS)
      usual.set(
        workflow,
        quantile(
          runs.map((run) => run.wallMs!).sort((a, b) => a - b),
          0.9,
        ),
      );

  // Then the whole run, for the newest RUN_LIMIT only.
  const shown = summaries.slice(0, RUN_LIMIT);
  const superseded = supersedingRuns(summaries, shown);
  const envs = new Map<string, Environment>();
  const envUse = new Map<string, number>();
  const parsed = new Map<string, Environment>();
  const runs = shown.map((summary): Run => {
    const { group, row } = summary;
    const keys = new Set<string>();
    for (const raw of splitEnvs(group?.envs ?? null)) {
      let env = parsed.get(raw);
      if (!env) {
        const [labels, runnerGroup, machine] = raw.split("\u001f");
        env = environmentFor(JSON.parse(labels) as string[], runnerGroup || null, machine || null);
        parsed.set(raw, env);
      }
      envs.set(env.key, env);
      keys.add(env.key);
    }
    for (const key of keys) envUse.set(key, (envUse.get(key) ?? 0) + 1);
    const repository = row?.repositoryFullName ?? group?.repository ?? "";
    const runId = row?.id ?? group?.run_id ?? 0;
    const runAttempt = row?.runAttempt ?? group?.run_attempt ?? 1;
    return {
      ...runFields(row, { repository, runId, runAttempt }),
      repositoryId: row?.repositoryId ?? group?.repository_id ?? 0,
      runId,
      runAttempt,
      workflow: row?.workflowName ?? group?.workflow_name ?? null,
      status: summary.status,
      conclusion: summary.conclusion,
      startedAt: summary.startedAt,
      updatedAt: summary.updatedAt,
      wallMs: summary.wallMs,
      environments: [...keys],
      routed: Boolean(Number(group?.routed ?? 0)),
      usualMs: usual.get(summary.workflow) ?? null,
      supersededBy: superseded.get(summary) ?? null,
    };
  });
  await nameMachines(db, workspaceId, envs);
  return {
    days: windowDays(read),
    environments: [...envs.values()].sort(
      (a, b) => (envUse.get(b.key) ?? 0) - (envUse.get(a.key) ?? 0),
    ),
    runs,
    truncated: summaries.length > RUN_LIMIT,
  };
}

export interface RunJob {
  id: number;
  name: string;
  /**
   * Environment key: where it ran, or for a queued job the runner it's waiting for. Null for a job
   * that finished without a runner taking it.
   */
  environment: string | null;
  status: RunStatus;
  conclusion: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** How long the job usually takes where it runs, when it has FEW_RUNS+ successful runs there. */
  typical: TypicalTime | null;
}

/** What a run's detail says about the run itself, for when the run list hasn't loaded it. */
export type RunHeader = Pick<
  Run,
  | "repository"
  | "workflow"
  | "title"
  | "event"
  | "actor"
  | "sha"
  | "branch"
  | "pullRequest"
  | "url"
  | "status"
  | "conclusion"
>;

/**
 * One run attempt's jobs from job_timing, picks left out: finished ones and ones still queued or
 * running. Oldest queued first. Jobs that wait on others (`needs:`) only show once GitHub queues
 * them, since GitHub doesn't create them before. `run` is null when nothing of the run is known.
 * `walk` is how the run's pick walked the runner order, for a run RelayRunner routed.
 */
export async function runJobs(
  db: Db,
  workspaceId: string,
  run: { repositoryId: number; runId: number; runAttempt: number },
): Promise<{
  run: RunHeader | null;
  environments: Environment[];
  jobs: RunJob[];
  walk: RouteWalk | null;
}> {
  const [rows, [row], picks] = await Promise.all([
    db
      .select()
      .from(timing)
      .where(
        and(
          eq(timing.runId, run.runId),
          eq(timing.runAttempt, run.runAttempt),
          eq(timing.repositoryId, run.repositoryId),
          inWorkspace(workspaceId),
          sql`not ${PICK}`,
        ),
      ),
    db
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, run.runId),
          eq(table.runAttempt, run.runAttempt),
          eq(table.repositoryId, run.repositoryId),
          inWorkspace(workspaceId, table.installationId),
        ),
      )
      .limit(1),
    picksForJobs(db, [run]),
  ]);
  const first = rows[0];
  const repository = row?.repositoryFullName ?? first?.repositoryFullName;
  let header: RunHeader | null = null;
  if (repository) {
    // Without a workflow_run row, the run is going while any of its jobs is.
    const status = row
      ? runStatus(row.status)
      : rows.some((each) => !each.completedAt)
        ? "in_progress"
        : "completed";
    const count = (conclusion: string) =>
      rows.filter((each) => each.conclusion === conclusion).length;
    header = {
      ...runFields(row, { repository, ...run }),
      workflow: row?.workflowName ?? first?.workflowName ?? null,
      status,
      conclusion:
        status !== "completed"
          ? null
          : runConclusion(row?.conclusion, {
              failed: count("failure"),
              timed_out: count("timed_out"),
              cancelled: count("cancelled"),
            }),
    };
  }

  const envs = new Map<string, Environment>();
  const envOf = (row: (typeof rows)[number]) => {
    const env = environmentFor(row.labels, row.runnerGroupName, row.machineId);
    envs.set(env.key, env);
    return env.key;
  };
  const jobs = rows.map((row): RunJob => {
    const status = row.completedAt ? "completed" : row.startedAt ? "in_progress" : "queued";
    return {
      id: row.id,
      name: row.name,
      environment: status === "completed" && !row.startedAt ? null : envOf(row),
      status,
      conclusion: row.conclusion,
      queuedAt: row.queuedAt?.getTime() ?? null,
      startedAt: row.startedAt?.getTime() ?? null,
      completedAt: row.completedAt?.getTime() ?? null,
      typical: null,
    };
  });
  const keyOf = (job: RunJob, environment: string) => ({
    repositoryId: run.repositoryId,
    workflow: header?.workflow ?? null,
    name: job.name,
    environment,
  });
  const [typical] = await Promise.all([
    header
      ? typicalJobTimes(
          db,
          workspaceId,
          jobs.flatMap((job) => (job.environment ? [keyOf(job, job.environment)] : [])),
        )
      : Promise.resolve(new Map<string, TypicalTime>()),
    nameMachines(db, workspaceId, envs),
  ]);
  for (const job of jobs)
    if (job.environment) job.typical = typical.get(typicalKey(keyOf(job, job.environment))) ?? null;
  return {
    run: header,
    // Only once the run is known to be the workspace's: decisions aren't scoped to one.
    walk: header ? (picks.get(jobKey(run))?.walk ?? null) : null,
    environments: [...envs.values()],
    jobs: jobs.sort(
      (a, b) => (a.queuedAt ?? Infinity) - (b.queuedAt ?? Infinity) || a.name.localeCompare(b.name),
    ),
  };
}

/** A job still going: running on a runner, or queued and waiting for one. Times are epoch ms. */
export interface LiveJob {
  id: number;
  repositoryId: number;
  repository: string;
  runId: number;
  runAttempt: number;
  workflow: string | null;
  name: string;
  /** Its runs-on labels. */
  labels: string[];
  /** Environment key: where it runs, or for a queued job the runner it's waiting for. */
  environment: string;
  queuedAt: number | null;
  startedAt: number | null;
  /**
   * How long the job usually takes on its environment, when it has FEW_RUNS+ successful runs there.
   * With startedAt, when it should finish.
   */
  typical: TypicalTime | null;
}

export interface LiveJobs {
  environments: Environment[];
  /** Running now, longest running first. */
  running: LiveJob[];
  /** Waiting for a runner, longest waiting first. */
  queued: LiveJob[];
}

/** Jobs left unfinished longer than this are left out: GitHub never said they ended. */
const LIVE_MS = DAY_MS;
/** Most jobs the live list returns. */
const LIVE_LIMIT = 200;

/**
 * The workspace's jobs still going, picks left out, for the Runners page. One range of
 * job_timing_installation_idx: the workspace's installations with completed_at null.
 */
export async function liveJobs(db: Db, workspaceId: string, now = Date.now()): Promise<LiveJobs> {
  const since = sql`coalesce(${timing.startedAt}, ${timing.queuedAt}, ${timing.createdAt})`;
  const rows = await db
    .select({
      id: timing.id,
      repositoryId: timing.repositoryId,
      repository: timing.repositoryFullName,
      runId: timing.runId,
      runAttempt: timing.runAttempt,
      workflow: timing.workflowName,
      name: timing.name,
      labels: timing.labels,
      runnerGroupName: timing.runnerGroupName,
      machineId: timing.machineId,
      queuedAt: timing.queuedAt,
      startedAt: timing.startedAt,
    })
    .from(timing)
    .where(
      and(
        inWorkspace(workspaceId),
        sql`${timing.completedAt} is null and not ${PICK} and ${since} >= ${now - LIVE_MS}`,
      ),
    )
    // Running jobs by when they started, queued ones by when they were queued: oldest first.
    .orderBy(since)
    .limit(LIVE_LIMIT);
  const envs = new Map<string, Environment>();
  const running: LiveJob[] = [];
  const queued: LiveJob[] = [];
  for (const { runnerGroupName, machineId, ...row } of rows) {
    const env = environmentFor(row.labels, runnerGroupName, machineId);
    envs.set(env.key, env);
    const job: LiveJob = {
      ...row,
      environment: env.key,
      queuedAt: row.queuedAt?.getTime() ?? null,
      startedAt: row.startedAt?.getTime() ?? null,
      typical: null,
    };
    (job.startedAt === null ? queued : running).push(job);
  }
  const all = [...running, ...queued];
  const [typical] = await Promise.all([
    typicalJobTimes(db, workspaceId, all, now),
    nameMachines(db, workspaceId, envs),
  ]);
  for (const job of all) job.typical = typical.get(typicalKey(job)) ?? null;
  return { environments: [...envs.values()], running, queued };
}

/** Where one of the workspace's jobs lives on GitHub, or null when it isn't the workspace's. */
export async function jobSource(db: Db, workspaceId: string, jobId: number) {
  const [row] = await db
    .select({ installationId: timing.installationId, repository: timing.repositoryFullName })
    .from(timing)
    .where(and(eq(timing.id, jobId), inWorkspace(workspaceId)))
    .limit(1);
  return row ?? null;
}

/**
 * Each workflow's whole-run times in the window, by workflowKey, for the Performance page: like a
 * job's times, from its newest successful runs, but first job queued to last job finished. Its
 * wait is the time no job was running (waitingMs). When hasTrend, it reads the prior window too.
 */
export async function workflowTimes(
  db: Db,
  workspaceId: string,
  window: ReportWindow,
  now = Date.now(),
): Promise<Map<string, Stat>> {
  const trend = hasTrend(window, now);
  const [current, prior] = await Promise.all([
    runSummaries(db, workspaceId, window),
    trend ? runSummaries(db, workspaceId, window.prior) : [],
  ]);
  const finished = new Map<string, number>();
  for (const summary of current)
    if (summary.status === "completed" && summary.conclusion !== "cancelled")
      finished.set(summary.workflow, (finished.get(summary.workflow) ?? 0) + 1);
  const bucket = (runs: RunSummary[] = [], total = runs.length) => ({
    runs: total,
    successes: runs.length,
    samples: runs.map((run) => ({
      completedAt: run.updatedAt,
      runMs: run.wallMs!,
      waitMs: run.waitMs,
    })),
  });
  const walls = successfulWalls(current);
  const priorWalls = successfulWalls(prior);
  return new Map(
    [...finished].map(([key, total]) => [
      key,
      statOf(bucket(walls.get(key), total), trend ? bucket(priorWalls.get(key)) : undefined),
    ]),
  );
}

export type { PerformanceReport };

const NO_COST = { usd: null, environments: [], fastest: null, runMs: 0, spentUsd: 0 };

/**
 * The Performance page: job times per runner, plus each workflow's whole-run times, cost per run
 * and fastest runner (src/workflow-compare.ts).
 */
export async function performanceReport(
  db: Db,
  workspaceId: string,
  window: ReportWindow,
): Promise<PerformanceReport> {
  const [report, walls, costs] = await Promise.all([
    jobTimesReport(db, workspaceId, window),
    workflowTimes(db, workspaceId, window),
    workflowCosts(db, workspaceId, window),
  ]);
  return {
    ...report,
    workflows: report.workflows.map((row) => {
      const key = workflowKey(row.repositoryId, row.workflow);
      return {
        ...row,
        wall: walls.get(key) ?? null,
        ...(costs.get(key) ?? NO_COST),
      };
    }),
  };
}
