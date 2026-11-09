// Runs: each workflow run in the workspace's repos, newest first, for the dashboard's Runs page. A
// run's title, trigger and status come from workflow_run webhooks (stored here); its jobs, wall time
// and runners come from job_timing (src/job-timings.ts), so runs from before the App sent
// workflow_run still show, with less detail.
//
// Database cost: the list is two statements, run together, each a range of an installation index
// (job_timing_installation_idx, workflow_run_installation_idx) over the last USUAL_DAYS days, never
// a scan. One run's jobs are a range of job_timing_run_idx and workflow_job_run_idx.
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { findInstallation } from "./installations.ts";
import {
  type Environment,
  environmentFor,
  FEW_RUNS,
  inWorkspace,
  nameMachines,
  quantile,
} from "./job-times.ts";
import { DAY_MS, JOB_TIMING_RETENTION_DAYS } from "./job-timings.ts";
import { parseDate } from "./jobs.ts";
import { RELAYRUNNER_LABEL } from "./webhook-queue.ts";

type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;

const table = schema.workflowRun;
const timing = schema.jobTiming;

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 14;
/** A workflow's usual time is the p90 of its successful runs over this many days. */
export const USUAL_DAYS = 14;
/** Most runs one list returns. */
export const RUN_LIMIT = 200;

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

// Rows deleted per statement, so one purge never runs long. The hourly cron catches up on the rest.
const PURGE_BATCH = 5_000;

/** Deletes runs last updated before job_timing's retention window. Returns how many rows went. */
export async function purgeOldWorkflowRuns(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - JOB_TIMING_RETENTION_DAYS * DAY_MS);
  let deleted = 0;
  for (let i = 0; i < 10; i += 1) {
    const result = await db.run(sql`
      delete from ${table} where rowid in (
        select rowid from ${table} where ${table.githubUpdatedAt} < ${cutoff.getTime()}
        limit ${PURGE_BATCH})`);
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < PURGE_BATCH) break;
  }
  return deleted;
}

export type RunStatus = "queued" | "in_progress" | "completed";

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
  completedAt: number | null;
  /** First job queued (or the run started) to last job finished. */
  wallMs: number | null;
  /** Jobs that finished, picks left out. */
  jobs: number;
  /** Where its jobs ran, as environment keys, most used first. */
  environments: string[];
  /** A RelayRunner pick chose its runners. */
  routed: boolean;
  /** The workflow's usual time: the p90 of its successful runs, with FEW_RUNS+ of them. */
  usualMs: number | null;
}

export interface RunsReport {
  days: number;
  usualDays: number;
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

const PICK = sql`lower(${timing.labels}) like ${`%"${RELAYRUNNER_LABEL}"%`}`;
const RAN_HERE = sql`${timing.startedAt} is not null and ${timing.runnerName} is not null
  and coalesce(${timing.conclusion}, '') <> 'skipped'`;

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
      group_concat(distinct case when not ${PICK} and ${RAN_HERE} then ${timing.labels}
        || char(31) || coalesce(${timing.runnerGroupName}, '')
        || char(31) || coalesce(${timing.machineId}, '') || char(30) end) as envs
    from ${timing}
    where ${inWorkspace(workspaceId)} and ${timing.completedAt} >= ${since}
    group by ${timing.repositoryId}, ${timing.runId}, ${timing.runAttempt}`;
}

function runsInWorkspace(workspaceId: string) {
  return sql`${table.installationId} in (
    select ${schema.githubInstallation.id} from ${schema.githubInstallation}
    where ${schema.githubInstallation.workspaceId} = ${workspaceId})`;
}

/** `labels␟group␟machine␞,...` → the environments, each once. */
export function parseEnvs(text: string | null): Environment[] {
  if (!text) return [];
  return text
    .split("\u001e")
    .map((part) => part.replace(/^,/, ""))
    .filter(Boolean)
    .map((part) => {
      const [labels, group, machine] = part.split("\u001f");
      return environmentFor(JSON.parse(labels) as string[], group || null, machine || null);
    });
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

/** The workspace's runs active in the last `days` days, newest first, at most RUN_LIMIT. */
export async function listRuns(
  db: Db,
  workspaceId: string,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<RunsReport> {
  // The usual times need the longer window, so both statements read it and the list is cut after.
  const usualSince = now - USUAL_DAYS * DAY_MS;
  const since = now - days * DAY_MS;
  const [groups, rows] = await Promise.all([
    db.all<JobGroup>(jobGroupsQuery(workspaceId, usualSince)),
    db
      .select()
      .from(table)
      .where(and(runsInWorkspace(workspaceId), sql`${table.githubUpdatedAt} >= ${usualSince}`)),
  ]);

  const byKey = new Map(rows.map((row) => [runKey(row.repositoryId, row.id, row.runAttempt), row]));
  const groupsByKey = new Map(
    groups.map((group) => [runKey(group.repository_id, group.run_id, group.run_attempt), group]),
  );
  const envs = new Map<string, Environment>();
  const envUse = new Map<string, number>();
  const runs: Run[] = [];
  // When each run last changed, for the window and the order.
  const lastActivity = new Map<Run, number>();
  for (const key of new Set([...groupsByKey.keys(), ...byKey.keys()])) {
    const group = groupsByKey.get(key);
    const row = byKey.get(key);
    // A run seen only as a pick (its jobs still running, no workflow_run yet) has nothing to show.
    if (!row && !Number(group?.jobs)) continue;
    const status = runStatus(row?.status);
    const startedAt = row?.runStartedAt?.getTime() ?? group?.first_queued ?? null;
    const completedAt =
      status === "completed"
        ? (group?.last_completed ?? row?.githubUpdatedAt.getTime() ?? null)
        : null;
    const runEnvs = parseEnvs(group?.envs ?? null);
    for (const env of runEnvs) {
      if (!envs.has(env.key)) envs.set(env.key, env);
      envUse.set(env.key, (envUse.get(env.key) ?? 0) + 1);
    }
    const repository = row?.repositoryFullName ?? group?.repository ?? "";
    const runId = row?.id ?? group?.run_id ?? 0;
    const runAttempt = row?.runAttempt ?? group?.run_attempt ?? 1;
    const run: Run = {
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
      status,
      conclusion:
        status !== "completed"
          ? null
          : (row?.conclusion ?? (group ? conclusionOfJobs(group) : null)),
      startedAt,
      completedAt,
      wallMs:
        startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
      jobs: Number(group?.jobs ?? 0),
      environments: [...new Set(runEnvs.map((env) => env.key))],
      routed: Boolean(Number(group?.routed ?? 0)),
      usualMs: null,
    };
    runs.push(run);
    lastActivity.set(
      run,
      Math.max(group?.last_completed ?? 0, row?.githubUpdatedAt.getTime() ?? 0),
    );
  }

  // Each workflow's usual time, from its successful runs over the whole USUAL_DAYS.
  const walls = new Map<string, number[]>();
  for (const run of runs) {
    if (run.conclusion !== "success" || run.wallMs === null) continue;
    const id = `${run.repositoryId}\u001f${run.workflow ?? ""}`;
    walls.set(id, [...(walls.get(id) ?? []), run.wallMs]);
  }
  const usual = new Map(
    [...walls].flatMap(([id, times]) =>
      times.length < FEW_RUNS
        ? []
        : [
            [
              id,
              quantile(
                times.sort((a, b) => a - b),
                0.9,
              ),
            ] as const,
          ],
    ),
  );

  const activity = (run: Run) => lastActivity.get(run) ?? 0;
  const recent = runs
    .filter((run) => activity(run) >= since)
    .sort((a, b) => activity(b) - activity(a));
  await nameMachines(db, workspaceId, envs);
  return {
    days,
    usualDays: USUAL_DAYS,
    environments: [...envs.values()].sort(
      (a, b) => (envUse.get(b.key) ?? 0) - (envUse.get(a.key) ?? 0),
    ),
    runs: recent.slice(0, RUN_LIMIT).map((run) => ({
      ...run,
      usualMs: usual.get(`${run.repositoryId}\u001f${run.workflow ?? ""}`) ?? null,
    })),
    truncated: recent.length > RUN_LIMIT,
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
          inArray(
            job.installationId,
            db
              .select({ id: schema.githubInstallation.id })
              .from(schema.githubInstallation)
              .where(eq(schema.githubInstallation.workspaceId, workspaceId)),
          ),
        ),
      ),
  ]);

  const envs = new Map<string, Environment>();
  const envOf = (labels: string[], group: string | null, machineId: string | null) => {
    const env = environmentFor(labels, group, machineId);
    if (!envs.has(env.key)) envs.set(env.key, env);
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
