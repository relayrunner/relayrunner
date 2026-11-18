// The jobs a connected machine ran, for RelayRunner for Mac, which asks with the machine's own
// token (`Authorization: Bearer rrm_…`) rather than a person's session. A machine only ever sees
// jobs that ran on it: their name, times and result, the steps GitHub reports and, for a failed
// one, why (machineJobFailure). It ran those jobs, so nothing here is new to it.
//
// Database cost: the list, its running jobs and its repos and workflows are each one range of
// job_timing_machine_idx; a job is one primary-key read.
import {
  and,
  count,
  type SQL,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { appInstallationToken, type JobStep, workflowJobSteps } from "./github-app.ts";
import type { Env } from "./env.ts";
import { FAILED_CONCLUSIONS } from "./job-counts.ts";
import { Recent } from "./recent.ts";
import { jobUrl } from "./run-job.ts";

const table = schema.jobTiming;

export const MAX_MACHINE_JOBS = 100;

// A job that started (or was sent here) longer ago than this and never said it finished lost its
// `completed` webhook, so it isn't shown as running. The purge keeps such rows for a week.
const ACTIVE_MS = 24 * 3_600_000;
const MAX_ACTIVE = 20;
// Repos and workflows offered as filters, most jobs first, kept a few minutes per machine since
// each read covers its whole week.
const MAX_FACETS = 50;
const FACETS_MS = 5 * 60_000;

// The results a machine can filter by, split as History and Admin › Jobs split them: anything
// that ended neither succeeded nor failed counts as canceled.
export const JOB_RESULTS = ["succeeded", "failed", "canceled"] as const;
export type JobResult = (typeof JOB_RESULTS)[number];

function resultIs(result: JobResult) {
  switch (result) {
    case "succeeded":
      return eq(table.conclusion, "success");
    case "failed":
      return inArray(table.conclusion, FAILED_CONCLUSIONS);
    case "canceled":
      return notInArray(table.conclusion, ["success", ...FAILED_CONCLUSIONS]);
  }
}

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
        filter.result === undefined ? undefined : resultIs(filter.result),
        filter.since === undefined ? undefined : gte(table.completedAt, new Date(filter.since)),
        before === undefined ? undefined : lt(table.completedAt, new Date(before)),
      ),
    )
    .orderBy(desc(table.completedAt))
    .limit(limit + 1);
  if (before !== undefined) return page(await finished, limit);
  const [rows, active, choices] = await Promise.all([
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
          // Running first, newest first, then the ones waiting to start.
          .orderBy(isNull(table.startedAt), desc(table.startedAt), desc(table.queuedAt))
          .limit(MAX_ACTIVE)
      : Promise.resolve([]),
    facets.get(machineId, FACETS_MS, () => machineFacets(db, mine)),
  ]);
  return { ...page(rows, limit), active: active.map(present), ...choices };
}

const facets = new Recent<string, { repos: string[]; workflows: string[] }>(500);

async function machineFacets(db: Db, mine: SQL) {
  const rows = await db
    .select({ repo: table.repositoryFullName, workflow: table.workflowName })
    .from(table)
    .where(and(mine, isNotNull(table.completedAt)))
    .groupBy(table.repositoryFullName, table.workflowName)
    .orderBy(desc(count()));
  const most = (values: (string | null)[]) =>
    [...new Set(values.filter((value) => value !== null))].slice(0, MAX_FACETS);
  return {
    repos: most(rows.map((row) => row.repo)),
    workflows: most(rows.map((row) => row.workflow)),
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

/** Forget the steps and filter choices kept for machines. For tests. */
export function forgetMachineJobs() {
  finishedSteps.clear();
  facets.clear();
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
