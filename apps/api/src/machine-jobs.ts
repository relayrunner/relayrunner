// The jobs a connected machine ran, for RelayRunner for Mac, which asks with the machine's own
// token (`Authorization: Bearer rrm_…`) rather than a person's session. A machine only ever sees
// jobs that ran on it: their name, times and result, the steps GitHub reports and, for a failed
// one, why (machineJobFailure). It ran those jobs, so nothing here is new to it.
//
// Database cost: the list, its running jobs and its repos and workflows are each one range of
// job_timing_machine_idx; a job is one primary-key read.
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { appInstallationToken, type JobStep, workflowJobSteps } from "./github-app.ts";
import type { Env } from "./env.ts";
import { Recent } from "./recent.ts";
import { jobUrl } from "./run-job.ts";

const table = schema.jobTiming;

export const MAX_MACHINE_JOBS = 100;

// A job that started (or was sent here) longer ago than this and never said it finished lost its
// `completed` webhook, so it isn't shown as running.
const ACTIVE_MS = 24 * 3_600_000;
const MAX_ACTIVE = 20;
// Repos and workflows offered as filters, most jobs first.
const MAX_FACETS = 50;

// GitHub's conclusions for each result a machine can filter by, as the Mac app groups them.
export const RESULTS = {
  succeeded: ["success"],
  failed: ["failure", "timed_out", "startup_failure"],
  canceled: ["cancelled", "skipped"],
} as const;
export type JobResult = keyof typeof RESULTS;

export interface MachineJobFilter {
  repo?: string;
  workflow?: string;
  result?: JobResult;
  // Finished at or after, in ms.
  since?: number;
}

export interface MachineJob {
  id: number;
  name: string;
  workflow: string | null;
  repo: string;
  url: string;
  runId: number;
  runAttempt: number;
  // GitHub's conclusion, such as success or failure; null while it runs.
  conclusion: string | null;
  // "3. Run tests" when GitHub said which step failed.
  failedStep: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}

const columns = {
  id: table.id,
  name: table.name,
  workflow: table.workflowName,
  repo: table.repositoryFullName,
  runId: table.runId,
  runAttempt: table.runAttempt,
  conclusion: table.conclusion,
  failedStep: table.failedStep,
  queuedAt: table.queuedAt,
  startedAt: table.startedAt,
  completedAt: table.completedAt,
  installationId: table.installationId,
};

const selectJobs = (db: Db) => db.select(columns).from(table);
type Row = Awaited<ReturnType<typeof selectJobs>>[number];

function present(row: Row): MachineJob {
  const time = (date: Date | null) => date?.getTime() ?? null;
  return {
    id: row.id,
    name: row.name,
    workflow: row.workflow,
    repo: row.repo,
    url: jobUrl(row.repo, row.runId, row.id),
    runId: row.runId,
    runAttempt: row.runAttempt,
    conclusion: row.conclusion,
    failedStep: row.failedStep,
    queuedAt: time(row.queuedAt),
    startedAt: time(row.startedAt),
    completedAt: time(row.completedAt),
  };
}

/**
 * The machine's finished jobs, newest first, `limit` at a time. `before` (a completedAt in ms)
 * continues a page. Jobs are kept as long as job_timing keeps them, about a week.
 *
 * The first page (no `before`) also has the jobs running or waiting to start on it now, unless
 * it's filtered by result, and the repos and workflows it ran jobs from, for filters.
 */
export async function machineJobs(
  db: Db,
  machineId: string,
  { limit = 50, before, ...filter }: { limit?: number; before?: number } & MachineJobFilter = {},
  now = Date.now(),
): Promise<{
  jobs: MachineJob[];
  next: number | null;
  active?: MachineJob[];
  repos?: string[];
  workflows?: string[];
}> {
  const mine = eq(table.machineId, machineId);
  const picked = [
    filter.repo === undefined ? undefined : eq(table.repositoryFullName, filter.repo),
    filter.workflow === undefined ? undefined : eq(table.workflowName, filter.workflow),
  ];
  const finished = selectJobs(db)
    .where(
      and(
        mine,
        isNotNull(table.completedAt),
        ...picked,
        filter.result === undefined
          ? undefined
          : inArray(table.conclusion, [...RESULTS[filter.result]]),
        filter.since === undefined ? undefined : gte(table.completedAt, new Date(filter.since)),
        before === undefined ? undefined : lt(table.completedAt, new Date(before)),
      ),
    )
    .orderBy(desc(table.completedAt))
    .limit(limit + 1);
  if (before !== undefined) return page(await finished, limit);
  const [rows, active, facets] = await Promise.all([
    finished,
    filter.result === undefined
      ? selectJobs(db)
          .where(
            and(
              mine,
              isNull(table.completedAt),
              ...picked,
              sql`coalesce(${table.startedAt}, ${table.queuedAt}, ${table.createdAt}) >= ${now - ACTIVE_MS}`,
            ),
          )
          .orderBy(desc(table.startedAt), desc(table.queuedAt))
          .limit(MAX_ACTIVE)
      : Promise.resolve([]),
    db
      .select({ repo: table.repositoryFullName, workflow: table.workflowName, jobs: count() })
      .from(table)
      .where(and(mine, isNotNull(table.completedAt)))
      .groupBy(table.repositoryFullName, table.workflowName)
      .orderBy(desc(count())),
  ]);
  const most = (values: (string | null)[]) =>
    [...new Set(values.filter((value) => value !== null))].slice(0, MAX_FACETS);
  return {
    ...page(rows, limit),
    // Running first, newest first, then the ones waiting to start.
    active: active.map(present).sort((a, b) => Number(!a.startedAt) - Number(!b.startedAt)),
    repos: most(facets.map((row) => row.repo)),
    workflows: most(facets.map((row) => row.workflow)),
  };
}

function page(rows: Row[], limit: number) {
  const jobs = rows.slice(0, limit).map(present);
  return { jobs, next: rows.length > limit ? (jobs.at(-1)?.completedAt ?? null) : null };
}

/** One job that ran on the machine, or undefined when it didn't run there. */
export async function machineJob(db: Db, machineId: string, jobId: number) {
  const [row] = await selectJobs(db)
    .where(and(eq(table.id, jobId), eq(table.machineId, machineId)))
    .limit(1);
  return row && { job: present(row), installationId: row.installationId };
}

/** The job's steps from GitHub, or null when GitHub doesn't have the job any more. */
export async function machineJobSteps(
  env: Env,
  job: MachineJob,
  installationId: number,
): Promise<JobStep[] | null> {
  const read = async () =>
    workflowJobSteps(await appInstallationToken(env, installationId), job.repo, job.id);
  // A finished job's steps don't change, so the Jobs window going back to one doesn't ask GitHub
  // again. A running job's do.
  if (job.completedAt === null) return read();
  return finishedSteps.get(job.id, STEPS_MS, read, (steps) => steps !== null);
}

const finishedSteps = new Recent<number, JobStep[] | null>(500);
const STEPS_MS = 30 * 60_000;

/** Forget the steps kept for finished jobs. For tests. */
export function forgetFinishedSteps() {
  finishedSteps.clear();
}

/**
 * The machine's workspace for an installation's jobs, for workspace settings such as whether AI
 * explains failures. Null when the machine has left every workspace on that installation.
 */
export async function machineWorkspaceFor(
  db: Db,
  machine: { id: string; workspaceId: string | null },
  installationId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(
      and(
        eq(schema.workspace.installationId, installationId),
        or(
          machine.workspaceId ? eq(schema.workspace.id, machine.workspaceId) : undefined,
          sql`${schema.workspace.id} in (
            select ${schema.machineWorkspace.workspaceId} from ${schema.machineWorkspace}
            where ${schema.machineWorkspace.machineId} = ${machine.id})`,
        ),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
