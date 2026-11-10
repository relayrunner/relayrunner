// Runs: each workflow run in the workspace's repos, newest first, for the dashboard's Runs page. A
// run's title, trigger and status come from workflow_run webhooks (stored here); its jobs, wall time
// and runners come from job_timing (src/job-timings.ts), so runs from before the App sent
// workflow_run still show, with less detail.
//
// Database cost: the list is two statements, run together, each a range of an installation index
// (job_timing_installation_idx, workflow_run_installation_idx) over the last USUAL_DAYS days, never
// a scan. One run's jobs are a range of job_timing_run_idx and workflow_job_run_idx.
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { findInstallation } from "./installations.ts";
import {
  type Environment,
  environmentFor,
  FEW_RUNS,
  inWorkspace,
  nameMachines,
  PICK,
  quantile,
  RAN_ON_RUNNER,
} from "./job-times.ts";
import { DAY_MS, JOB_TIMING_RETENTION_DAYS, purgeBefore } from "./job-timings.ts";
import { parseDate } from "./jobs.ts";

type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;

const table = schema.workflowRun;
const timing = schema.jobTiming;

/** A workflow's usual time is the p90 of its successful runs over this many days. */
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

/** Deletes runs last updated before job_timing's retention window. Returns how many rows went. */
export function purgeOldWorkflowRuns(db: Db, now = Date.now()): Promise<number> {
  return purgeBefore(
    db,
    table,
    table.githubUpdatedAt,
    new Date(now - JOB_TIMING_RETENTION_DAYS * DAY_MS),
  );
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
}

export interface RunsReport {
  /** The window: runs that changed in the last `days` days. */
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
}

/** The finished jobs of each run in the window, grouped by run: a range of the installation index. */
function jobGroupsQuery(workspaceId: string, since: number) {
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
        || char(31) || coalesce(${timing.machineId}, '') || char(30) end) as envs
    from ${timing}
    where ${inWorkspace(workspaceId)} and ${timing.completedAt} >= ${since}
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

function conclusionOfJobs(group: JobGroup) {
  if (Number(group.failed)) return "failure";
  if (Number(group.timed_out)) return "timed_out";
  if (Number(group.cancelled)) return "cancelled";
  return "success";
}

function runStatus(status: string | undefined): RunStatus {
  if (status === undefined || status === "completed") return "completed";
  return status === "in_progress" ? "in_progress" : "queued";
}

const runKey = (repositoryId: number, runId: number, runAttempt: number) =>
  `${repositoryId}:${runId}:${runAttempt}`;

type WorkflowRunRow = typeof table.$inferSelect;

/**
 * The workspace's runs that changed in the last USUAL_DAYS days, newest first, at most RUN_LIMIT.
 * The usual times need the whole window anyway, so the dashboard narrows the range itself.
 */
export async function listRuns(db: Db, workspaceId: string, now = Date.now()): Promise<RunsReport> {
  const since = now - USUAL_DAYS * DAY_MS;
  const [groups, rows] = await Promise.all([
    db.all<JobGroup>(jobGroupsQuery(workspaceId, since)),
    db
      .select()
      .from(table)
      .where(
        and(
          inWorkspace(workspaceId, table.installationId),
          sql`${table.githubUpdatedAt} >= ${since}`,
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
  const walls = new Map<string, number[]>();
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
      conclusion:
        status !== "completed"
          ? null
          : (row?.conclusion ?? (group ? conclusionOfJobs(group) : null)),
      wallMs:
        startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
      updatedAt: Math.max(group?.last_completed ?? 0, row?.githubUpdatedAt.getTime() ?? 0),
      workflow: `${row?.repositoryId ?? group?.repository_id}\u001f${
        row?.workflowName ?? group?.workflow_name ?? ""
      }`,
    };
    summaries.push(summary);
    if (summary.conclusion === "success" && summary.wallMs !== null) {
      const times = walls.get(summary.workflow) ?? [];
      times.push(summary.wallMs);
      walls.set(summary.workflow, times);
    }
  }
  // Each workflow's usual time, from its successful runs over the whole window.
  const usual = new Map<string, number | null>();
  for (const [workflow, times] of walls)
    if (times.length >= FEW_RUNS)
      usual.set(
        workflow,
        quantile(
          times.sort((a, b) => a - b),
          0.9,
        ),
      );

  // Then the whole run, for the newest RUN_LIMIT only.
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  const envs = new Map<string, Environment>();
  const envUse = new Map<string, number>();
  const parsed = new Map<string, Environment>();
  const runs = summaries.slice(0, RUN_LIMIT).map((summary): Run => {
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
      repositoryId: row?.repositoryId ?? group?.repository_id ?? 0,
      repository,
      runId,
      runAttempt,
      workflow: row?.workflowName ?? group?.workflow_name ?? null,
      title: row?.displayTitle ?? null,
      event: row?.event ?? null,
      actor: row?.actorLogin ?? null,
      branch: row?.headBranch ?? null,
      pullRequest: row?.pullRequestNumber ?? null,
      url:
        row?.htmlUrl ??
        `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
      status: summary.status,
      conclusion: summary.conclusion,
      startedAt: summary.startedAt,
      updatedAt: summary.updatedAt,
      wallMs: summary.wallMs,
      environments: [...keys],
      routed: Boolean(Number(group?.routed ?? 0)),
      usualMs: usual.get(summary.workflow) ?? null,
    };
  });
  await nameMachines(db, workspaceId, envs);
  return {
    days: USUAL_DAYS,
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
  /** Environment key; null while no runner has it. */
  environment: string | null;
  status: string;
  conclusion: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}

/**
 * One run attempt's jobs, picks left out: finished ones from job_timing, and for routed runs the
 * ones still going from workflow_job. Oldest queued first.
 */
export async function runJobs(
  db: Db,
  workspaceId: string,
  run: { repositoryId: number; runId: number; runAttempt: number },
): Promise<{ environments: Environment[]; jobs: RunJob[] }> {
  const job = schema.workflowJob;
  const [finished, live] = await Promise.all([
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
      .from(job)
      .where(
        and(
          eq(job.runId, run.runId),
          eq(job.kind, "job"),
          eq(job.runAttempt, run.runAttempt),
          eq(job.repositoryId, run.repositoryId),
          inWorkspace(workspaceId, job.installationId),
        ),
      ),
  ]);

  const envs = new Map<string, Environment>();
  const envOf = (labels: string[], group: string | null, machineId: string | null) => {
    const env = environmentFor(labels, group, machineId);
    envs.set(env.key, env);
    return env.key;
  };
  const jobs = new Map<number, RunJob>();
  for (const row of finished)
    jobs.set(row.id, {
      id: row.id,
      name: row.name,
      environment: row.startedAt ? envOf(row.labels, row.runnerGroupName, row.machineId) : null,
      status: "completed",
      conclusion: row.conclusion,
      queuedAt: row.queuedAt?.getTime() ?? null,
      startedAt: row.startedAt?.getTime() ?? null,
      completedAt: row.completedAt?.getTime() ?? null,
    });
  for (const row of live) {
    if (jobs.has(row.id)) continue;
    jobs.set(row.id, {
      id: row.id,
      name: row.name,
      environment: row.runnerName ? envOf(row.labels, null, row.machineId) : null,
      status: row.status,
      conclusion: row.conclusion,
      queuedAt: row.githubCreatedAt.getTime(),
      startedAt: row.startedAt?.getTime() ?? null,
      completedAt: row.completedAt?.getTime() ?? null,
    });
  }
  await nameMachines(db, workspaceId, envs);
  return {
    environments: [...envs.values()],
    jobs: [...jobs.values()].sort(
      (a, b) => (a.queuedAt ?? Infinity) - (b.queuedAt ?? Infinity) || a.name.localeCompare(b.name),
    ),
  };
}
