// The jobs a connected machine ran, for RelayRunner for Mac, which asks with the machine's own
// token (`Authorization: Bearer rrm_…`) rather than a person's session. A machine only ever sees
// jobs that ran on it: their name, times and result, the steps GitHub reports and, for a failed
// one, why (machineJobFailure). It ran those jobs, so nothing here is new to it.
//
// Database cost: the list is one range of job_timing_machine_idx; a job is one primary-key read.
import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { appInstallationToken, type JobStep, workflowJobSteps } from "./github-app.ts";
import type { Env } from "./env.ts";
import { jobUrl } from "./run-job.ts";

const table = schema.jobTiming;

export const MAX_MACHINE_JOBS = 100;

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
 */
export async function machineJobs(
  db: Db,
  machineId: string,
  { limit = 50, before }: { limit?: number; before?: number } = {},
): Promise<{ jobs: MachineJob[]; next: number | null }> {
  const rows = await selectJobs(db)
    .where(
      and(
        eq(table.machineId, machineId),
        isNotNull(table.completedAt),
        before === undefined ? undefined : lt(table.completedAt, new Date(before)),
      ),
    )
    .orderBy(desc(table.completedAt))
    .limit(limit + 1);
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
  return workflowJobSteps(await appInstallationToken(env, installationId), job.repo, job.id);
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
