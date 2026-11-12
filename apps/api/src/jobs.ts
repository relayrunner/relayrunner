import { hostedProviderOf } from "@relayrunner/providers";
import type {
  ActivityJob,
  ActivityRunner,
  ActivityStarters,
  RouteWalk,
} from "@relayrunner/activity";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { recordEvent } from "./activity.ts";
import { type Db, schema } from "./db/index.ts";
import { findInstallation, workspaceIdForInstallation } from "./installations.ts";
import { routeIdFromLabels } from "./routing.ts";

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;

const table = schema.workflowJob;

// How far along a status is. GitHub's pre-queue states ('requested', 'waiting', 'pending') count as
// queued. A row only moves to an equal or higher rank, so an unordered or retried delivery never
// rewinds it.
const rank = (status: SQL) =>
  sql`(case ${status} when 'completed' then 2 when 'in_progress' then 1 else 0 end)`;

/**
 * Records a workflow_job delivery for the Activity page. A `pick` job (it asked for the relayrunner
 * label) is always stored and marks its run as routed. Any other job is stored only when its run
 * already has a pick. A stored non-pick job also logs one `job.routed` event in its workspace's
 * Activity, the first time it's seen. Returns whether anything was written.
 *
 * Skipped when the installation has no row yet (its webhook hasn't arrived, or it was uninstalled).
 * A later event for the same job writes it, since each one carries the job's full state.
 */
export async function recordWorkflowJob(
  db: Db,
  message: WorkflowJobMessage,
  isPick: boolean,
): Promise<boolean> {
  const { installationId, job, repository } = message;
  const installation = installationId ? await findInstallation(db, installationId) : null;
  if (!installationId || !installation) return false;
  const workspaceId = await workspaceIdForInstallation(db, installationId);
  // Matched on run id alone, so a re-run of failed jobs (a new attempt that reuses the earlier
  // attempt's pick output) still counts as routed.
  if (!isPick && !(await runHasPick(db, job.runId))) return false;

  const row = {
    id: job.id,
    installationId,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    runId: job.runId,
    runAttempt: job.runAttempt,
    kind: isPick ? ("pick" as const) : ("job" as const),
    workflowName: job.workflowName,
    name: job.name,
    labels: job.labels,
    headBranch: job.headBranch,
    headSha: job.headSha,
    status: job.status,
    conclusion: job.conclusion,
    runnerName: job.runnerName,
    githubCreatedAt: parseDate(job.createdAt) ?? new Date(message.receivedAt),
    startedAt: parseDate(job.startedAt),
    completedAt: parseDate(job.completedAt),
  };
  await db
    .insert(table)
    .values(row)
    .onConflictDoUpdate({
      target: table.id,
      set: {
        repositoryFullName: sql`excluded.repository_full_name`,
        workflowName: sql`excluded.workflow_name`,
        name: sql`excluded.name`,
        labels: sql`excluded.labels`,
        status: sql`excluded.status`,
        conclusion: sql`excluded.conclusion`,
        runnerName: sql`coalesce(excluded.runner_name, ${table.runnerName})`,
        startedAt: sql`coalesce(excluded.started_at, ${table.startedAt})`,
        completedAt: sql`coalesce(excluded.completed_at, ${table.completedAt})`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`${rank(sql`${table.status}`)} <= ${rank(sql`excluded.status`)}`,
    });
  // The job's row now exists, so its event can point at it. Logged once per job (the event's
  // unique job index), whatever order its webhooks arrive in.
  if (!isPick && workspaceId)
    await recordEvent(db, {
      workspaceId,
      type: "job.routed",
      data: {},
      jobId: job.id,
      occurredAt: row.githubCreatedAt,
    });
  return true;
}

/**
 * A job's status once its webhooks say it has started ('in_progress' or 'completed'), or null when
 * they haven't yet or the job isn't stored. Null means "ask GitHub": a webhook may still be on its
 * way.
 */
export async function startedJobStatus(db: Db, jobId: number): Promise<string | null> {
  const [row] = await db
    .select({ status: table.status })
    .from(table)
    .where(eq(table.id, jobId))
    .limit(1);
  return row && (row.status === "in_progress" || row.status === "completed") ? row.status : null;
}

/**
 * Notes which machine a route sent a job to. Only fills an empty machine_id, so a redelivered
 * webhook never moves a job to another machine. A job that wasn't stored (no pick in its run) is
 * left alone.
 */
export async function setJobMachine(db: Db, jobId: number, machineId: string) {
  // The job's timing row too: this is the only place it learns its machine.
  await db.batch([
    db
      .update(table)
      .set({ machineId })
      .where(and(eq(table.id, jobId), isNull(table.machineId))),
    db
      .update(schema.jobTiming)
      .set({ machineId })
      .where(and(eq(schema.jobTiming.id, jobId), isNull(schema.jobTiming.machineId))),
  ]);
}

/** The job a machine is running, for its card on the Runners page. */
export type RunningJob = {
  repository: string;
  workflow: string | null;
  name: string;
  url: string;
  /** ISO time GitHub says it started, or null when it hasn't said. */
  startedAt: string | null;
};

/**
 * Each busy machine's in-progress jobs, newest first, by machine id: at most as many as it reports
 * `running`, so when an old row is stuck in_progress (a lost `completed` webhook) the newest ones
 * win. Callers pass only machines that report themselves busy, so a stuck row never shows on an
 * idle machine.
 *
 * A connected machine can be in several workspaces, each another GitHub account's. A machine
 * given `installationId` shows only that installation's jobs, so one workspace never learns the
 * repos and job names another workspace runs on a shared member's machine.
 */
export async function runningJobs(
  db: Db,
  machines: { id: string; running: number; installationId?: number | null }[],
) {
  const jobs = new Map<string, RunningJob[]>();
  const limit = new Map(machines.map((machine) => [machine.id, machine.running]));
  const only = new Map(
    machines.flatMap((machine) =>
      machine.installationId === undefined ? [] : [[machine.id, machine.installationId] as const],
    ),
  );
  if (machines.length === 0) return jobs;
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        inArray(table.machineId, [...limit.keys()]),
        eq(table.kind, "job"),
        eq(table.status, "in_progress"),
      ),
    )
    .orderBy(desc(table.githubCreatedAt));
  for (const row of rows) {
    if (!row.machineId) continue;
    if (only.has(row.machineId) && row.installationId !== only.get(row.machineId)) continue;
    const list = jobs.get(row.machineId) ?? [];
    if (list.length >= (limit.get(row.machineId) ?? 0)) continue;
    list.push({
      repository: row.repositoryFullName,
      workflow: row.workflowName,
      name: row.name,
      url: `https://github.com/${row.repositoryFullName}/actions/runs/${row.runId}/job/${row.id}`,
      startedAt: row.startedAt?.toISOString() ?? null,
    });
    jobs.set(row.machineId, list);
  }
  return jobs;
}

async function runHasPick(db: Db, runId: number) {
  const [pick] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.runId, runId), eq(table.kind, "pick")))
    .limit(1);
  return Boolean(pick);
}

export function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Where RelayRunner sent the job. The `rr-` label itself is never shown: it's a one-time id, not a
// runner.
function presentRunner(job: typeof table.$inferSelect, machineName: string | null): ActivityRunner {
  if (job.machineId || routeIdFromLabels(job.labels))
    return { type: "machine", machineId: job.machineId, name: machineName };
  const label = job.labels.join(", ");
  const hosted = job.labels.map(hostedProviderOf).find((id) => id !== null);
  if (hosted) return { type: "hosted", provider: hosted, label };
  return { type: "github", label };
}

/** A routed job's current state, for its Activity entry. */
export function presentJob(
  job: typeof table.$inferSelect,
  isPrivate: boolean | null,
  machineName: string | null,
  walk: RouteWalk | null = null,
  starters: ActivityStarters = { startedBy: null, rerunBy: null },
): ActivityJob {
  return {
    id: job.id,
    repository: job.repositoryFullName,
    // null when the repo isn't mirrored (yet).
    private: isPrivate,
    runId: job.runId,
    runAttempt: job.runAttempt,
    workflow: job.workflowName,
    name: job.name,
    // Where RelayRunner sent the job: GitHub resolved its runs-on to the pick's answer.
    runner: presentRunner(job, machineName),
    // Why it went there: how the run's pick walked the runner order.
    walk,
    runnerName: job.runnerName,
    branch: job.headBranch,
    sha: job.headSha,
    status: job.status,
    conclusion: job.conclusion,
    createdAt: job.githubCreatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    url: `https://github.com/${job.repositoryFullName}/actions/runs/${job.runId}/job/${job.id}`,
    runUrl: `https://github.com/${job.repositoryFullName}/actions/runs/${job.runId}`,
    starters,
  };
}
