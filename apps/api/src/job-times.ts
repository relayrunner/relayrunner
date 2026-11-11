// Job times: how long each workflow and job usually takes on each runner environment, over a
// rolling window, for the dashboard's Job times page. Read from job_timing (src/job-timings.ts),
// which already stores every finished job. Nothing is precomputed: the window is short, medians
// don't add up across days, and the per-job cap needs the samples anyway.
//
// Database cost: the summary is two statements, run together, each a range of
// job_timing_installation_idx (the workspace's installations, completed in the window), never a
// scan of the table. The detail is a range of job_timing_job_idx. job-times.test.ts checks the
// rows D1 reads.
import { PROVIDERS } from "@relayrunner/providers";
import { and, eq, gte, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { usesContainerRunner } from "./container-runner.ts";
import { type Db, schema } from "./db/index.ts";
import { DAY_MS, GITHUB_HOSTED_GROUP, RUNNER_RATES, runnerClass } from "./job-timings.ts";
import { cloudProviderFor, isGitHubHostedLabel } from "./cloud-providers.ts";
import { routeIdFromLabels } from "./routing.ts";
import { RELAYRUNNER_LABEL } from "./webhook-queue.ts";

const table = schema.jobTiming;

/** Newest successful runs kept per job and environment, so a busy job reflects its latest code. */
export const SAMPLE_CAP = 50;
/** Under this many runs a time is shown greyed and never compared. */
export const FEW_RUNS = 5;
/** Under this many runs a time is low confidence. */
export const ENOUGH_RUNS = 20;
export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 30;

export interface Environment {
  /** e.g. `github:linux-2-core`, `machine:<id>`, `container`. */
  key: string;
  label: string;
  detail: string;
}

const MACHINE = "machine:";

/**
 * The runner environment a job ran on. Derived when read, like runnerClass, so changing the rules
 * needs no backfill: the window is only a few weeks long.
 */
export function environmentFor(
  labels: string[],
  runnerGroupName: string | null,
  machineId: string | null,
): Environment {
  if (machineId) return { key: `${MACHINE}${machineId}`, label: "Machine", detail: "" };
  if (usesContainerRunner(labels))
    return {
      key: "container",
      label: "Cloudflare Container",
      detail: "standard-1",
    };
  const lower = labels.map((label) => label.toLowerCase());
  const provider = cloudProviderFor(lower);
  if (provider)
    return {
      key: `${provider.id}:${provider.label}`,
      label: provider.label,
      detail: PROVIDERS[provider.id].name,
    };
  const group = runnerGroupName ?? "Default";
  // Asked for by name: a `self-hosted` label, a pick, or a route to a machine.
  if (
    lower.includes("self-hosted") ||
    lower.includes(RELAYRUNNER_LABEL) ||
    routeIdFromLabels(labels)
  )
    return { key: `self-hosted:${group}`, label: "Self-hosted", detail: group };
  if (lower.some(isGitHubHostedLabel) || runnerGroupName === GITHUB_HOSTED_GROUP) {
    const cls = runnerClass(labels, runnerGroupName);
    if (cls !== "other" && cls !== "self-hosted")
      return { key: `github:${cls}`, label: RUNNER_RATES[cls].label, detail: "GitHub-hosted" };
    // A larger runner or an image without a standard price: named by its label.
    const label = lower[0] ?? "unknown";
    return { key: `github:${label}`, label, detail: "GitHub-hosted" };
  }
  // A label nothing above recognises: another service, or a self-hosted runner asked for only by
  // its custom labels.
  const label = lower[0] ?? "unknown";
  return { key: `other:${label}`, label, detail: runnerGroupName ?? "Unrecognized label" };
}

/**
 * Names each `machine:<id>` environment from its machine row. A deleted machine keeps its generic
 * name.
 */
export async function nameMachines(db: Db, workspaceId: string, envs: Map<string, Environment>) {
  const machineIds = [...envs.keys()].flatMap((key) =>
    key.startsWith(MACHINE) ? [key.slice(MACHINE.length)] : [],
  );
  if (!machineIds.length) return;
  const machines = await db
    .select({
      id: schema.machine.id,
      name: schema.machine.name,
      model: schema.machine.deviceModel,
      chip: schema.machine.chip,
      os: schema.machine.os,
    })
    .from(schema.machine)
    .where(
      and(eq(schema.machine.workspaceId, workspaceId), inArray(schema.machine.id, machineIds)),
    );
  for (const machine of machines) {
    const env = envs.get(`${MACHINE}${machine.id}`);
    if (!env) continue;
    env.label = machine.name;
    env.detail = [machine.model, machine.chip].filter(Boolean).join(" · ") || (machine.os ?? "");
  }
}

export type Confidence = "none" | "few" | "low" | "ok";

export function confidence(samples: number): Confidence {
  if (samples === 0) return "none";
  if (samples < FEW_RUNS) return "few";
  if (samples < ENOUGH_RUNS) return "low";
  return "ok";
}

/** The q-quantile (0..1) of ascending values, interpolated. */
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo));
}

interface Sample {
  completedAt: number;
  runMs: number;
  waitMs: number | null;
}

export interface Stat {
  /** Runs in the window that a runner finished, successful or not. */
  runs: number;
  successes: number;
  /** Successful runs behind the times, at most SAMPLE_CAP. */
  samples: number;
  confidence: Confidence;
  medianMs: number | null;
  p25Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
  /** Median wait from queued to started. Null for whole runs, or rows from before it was stored. */
  waitMs: number | null;
  /**
   * The newer half of the samples' median against the older half's, as a fraction (0.18 is 18%
   * slower). Null under 2 × FEW_RUNS samples. Comes from the same rows, so it costs no extra read.
   */
  trend: number | null;
}

export interface Bucket {
  runs: number;
  successes: number;
  samples: Sample[];
}

export function emptyBucket(): Bucket {
  return { runs: 0, successes: 0, samples: [] };
}

// Newest first, at most SAMPLE_CAP: a run outside a child's newest can't be in its parent's.
function newestOf(samples: Sample[]) {
  return samples.sort((a, b) => b.completedAt - a.completedAt).slice(0, SAMPLE_CAP);
}

export function mergeInto(into: Bucket, from: Bucket) {
  into.runs += from.runs;
  into.successes += from.successes;
  into.samples = newestOf(into.samples.concat(from.samples));
}

export function bucketOf(row: { runs: number; successes: number; samples: string | null }): Bucket {
  return {
    runs: Number(row.runs),
    successes: Number(row.successes),
    samples: newestOf(parseSamples(row.samples)),
  };
}

const ascending = (a: number, b: number) => a - b;
const medianRun = (samples: Sample[]) => quantile(samples.map((s) => s.runMs).sort(ascending), 0.5);

/** Times from a bucket's newest SAMPLE_CAP successful runs (kept newest first by mergeInto). */
export function statOf(bucket: Bucket): Stat {
  const newest = newestOf([...bucket.samples]);
  const runs = newest.map((s) => s.runMs).sort(ascending);
  const waits = newest
    .map((s) => s.waitMs)
    .filter((ms): ms is number => ms !== null)
    .sort(ascending);
  let trend: number | null = null;
  if (newest.length >= 2 * FEW_RUNS) {
    const half = Math.floor(newest.length / 2);
    const recent = medianRun(newest.slice(0, half));
    const older = medianRun(newest.slice(half));
    if (recent !== null && older) trend = Math.round(((recent - older) / older) * 100) / 100;
  }
  return {
    runs: bucket.runs,
    successes: bucket.successes,
    samples: newest.length,
    confidence: confidence(newest.length),
    medianMs: quantile(runs, 0.5),
    p25Ms: quantile(runs, 0.25),
    p75Ms: quantile(runs, 0.75),
    p90Ms: quantile(runs, 0.9),
    waitMs: quantile(waits, 0.5),
    trend,
  };
}

export interface EnvironmentSummary extends Environment {
  stat: Stat;
  /**
   * Against the baseline on the jobs both ran FEW_RUNS+ times: the geometric mean of this
   * environment's median over the baseline's (0.5 is twice as fast). Null for the baseline itself
   * or with no shared jobs.
   */
  versus: { ratio: number; sharedJobs: number } | null;
}

export interface JobRow {
  name: string;
  byEnvironment: Record<string, Stat>;
  /** Matrix legs (`test (node 24)`), when this row groups them under their shared name. */
  legs?: JobRow[];
}

export interface WorkflowRow {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  /** Whole runs, first job start to last job finish, for runs whose jobs all used one environment. */
  byEnvironment: Record<string, Stat>;
  jobs: JobRow[];
}

export interface JobTimesReport {
  days: number;
  sampleCap: number;
  baseline: string | null;
  environments: EnvironmentSummary[];
  workflows: WorkflowRow[];
}

interface WindowRow {
  repository_id: number;
  repository: string;
  workflow_name: string | null;
  /** The job's name. Null on whole-run rows. */
  name: string | null;
  labels: string;
  runner_group_name: string | null;
  machine_id: string | null;
  runs: number;
  successes: number;
  /** `completedAt:runMs:waitMs` per successful run, comma separated; waitMs may be empty. */
  samples: string | null;
}

/** A pick (`runs-on: relayrunner`): it only routes its run. */
export const PICK = sql`lower(${table.labels}) like ${`%"${RELAYRUNNER_LABEL}"%`}`;

/** A job a runner ran: started and not skipped. Cancelled jobs that started count. */
export const RAN_ON_RUNNER = sql`${table.startedAt} is not null and ${table.runnerName} is not null
  and coalesce(${table.conclusion}, '') <> 'skipped'`;

// A job a runner ran, picks left out: they would split every routed run across two environments,
// like on the Usage page; only successes give times.
const RAN = sql`${RAN_ON_RUNNER} and not ${PICK}`;

export const OK = sql`coalesce(${table.conclusion} = 'success', 0)`;

// `completedAt:runMs:waitMs` per successful run, comma separated, as parseSamples reads it.
export const SAMPLES = sql`group_concat(case when ${OK} then ${table.completedAt} || ':'
  || (${table.completedAt} - ${table.startedAt}) || ':'
  || coalesce(${table.startedAt} - ${table.queuedAt}, '') end)`;

/** The row's installation (job_timing's unless another column is given) is the workspace's. */
export function inWorkspace(
  workspaceId: string,
  installationId: SQLiteColumn = table.installationId,
): SQL {
  return sql`${installationId} in (
    select ${schema.githubInstallation.id} from ${schema.githubInstallation}
    where ${schema.githubInstallation.workspaceId} = ${workspaceId})`;
}

/**
 * The window's two aggregates, each a single range read of job_timing_installation_idx: the
 * workspace's installations, completed since `since`. Measured on D1, each reads about 2 rows per
 * row in the window (the range plus SQLite's GROUP BY sorter, which D1 counts too), however big
 * the table is. A single statement over a MATERIALIZED window with row_number() caps read more
 * than both together, since D1 also counts the temp table and the window sorts, so the
 * SAMPLE_CAP cut happens in TypeScript instead.
 */
/** The jobs a report counts: the workspace's, finished since `since`, run by a runner, not picks. */
export const windowWhere = (workspaceId: string, since: Date) =>
  sql`${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since.getTime()} and ${RAN}`;

export function windowQueries(workspaceId: string, since: Date) {
  const where = windowWhere(workspaceId, since);
  const jobs = sql`
    select ${table.repositoryId} as repository_id, min(${table.repositoryFullName}) as repository,
      ${table.workflowName} as workflow_name, ${table.name} as name, ${table.labels} as labels,
      ${table.runnerGroupName} as runner_group_name, ${table.machineId} as machine_id,
      count(*) as runs, sum(${OK}) as successes, ${SAMPLES} as samples
    from ${table} where ${where}
    group by ${table.repositoryId}, ${table.workflowName}, ${table.name}, ${table.labels},
      ${table.runnerGroupName}, ${table.machineId}`;
  // Whole runs, first job start to last job finish, kept only when every job used one environment.
  const env = sql`${table.labels} || char(31) || coalesce(${table.runnerGroupName}, '') || char(31) || coalesce(${table.machineId}, '')`;
  const runs = sql`
    select repository_id, min(repository) as repository, workflow_name, null as name, labels,
      runner_group_name, machine_id, count(*) as runs, sum(ok) as successes,
      group_concat(case when ok then completed_at || ':' || (completed_at - started_at) || ':' end) as samples
    from (
      select ${table.repositoryId} as repository_id, min(${table.repositoryFullName}) as repository,
        ${table.workflowName} as workflow_name, min(${table.labels}) as labels,
        min(${table.runnerGroupName}) as runner_group_name, min(${table.machineId}) as machine_id,
        count(distinct ${env}) as envs, min(${OK}) as ok,
        min(${table.startedAt}) as started_at, max(${table.completedAt}) as completed_at
      from ${table} where ${where}
      group by ${table.repositoryId}, ${table.workflowName}, ${table.runId}, ${table.runAttempt}
    )
    where envs = 1
    group by repository_id, workflow_name, labels, runner_group_name, machine_id`;
  return { jobs, runs };
}

export function parseSamples(text: string | null): Sample[] {
  if (!text) return [];
  return text.split(",").map((part) => {
    const [completedAt, runMs, waitMs] = part.split(":");
    return {
      completedAt: Number(completedAt),
      runMs: Math.max(0, Number(runMs)),
      waitMs: waitMs ? Math.max(0, Number(waitMs)) : null,
    };
  });
}

// `test (node 24)` is a leg of matrix job `test`.
function matrixName(name: string) {
  const at = name.indexOf(" (");
  return at > 0 && name.endsWith(")") ? name.slice(0, at) : null;
}

type Buckets = Map<string, Bucket>;

function add(buckets: Buckets, envKey: string, bucket: Bucket) {
  const into = buckets.get(envKey) ?? emptyBucket();
  mergeInto(into, bucket);
  buckets.set(envKey, into);
}

function stats(buckets: Buckets): Record<string, Stat> {
  return Object.fromEntries([...buckets].map(([key, bucket]) => [key, statOf(bucket)]));
}

/**
 * Against the baseline on shared jobs: the geometric mean of median ratios over every leaf job
 * that ran FEW_RUNS+ times on both, so 2× faster on one job and 2× slower on another even out.
 */
export function versusBaseline(jobs: Record<string, Stat>[], envKey: string, baseline: string) {
  const logs: number[] = [];
  for (const byEnv of jobs) {
    const mine = byEnv[envKey];
    const base = byEnv[baseline];
    if (!mine?.medianMs || !base?.medianMs) continue;
    if (mine.samples < FEW_RUNS || base.samples < FEW_RUNS) continue;
    logs.push(Math.log(mine.medianMs / base.medianMs));
  }
  if (!logs.length) return null;
  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  return { ratio: Math.round(Math.exp(mean) * 100) / 100, sharedJobs: logs.length };
}

/** The workspace's job times over the last `days` days. */
export async function jobTimesReport(
  db: Db,
  workspaceId: string,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<JobTimesReport> {
  const since = new Date(now - days * DAY_MS);
  const queries = windowQueries(workspaceId, since);
  const [jobRows, runRows] = await Promise.all([
    db.all<WindowRow>(queries.jobs),
    db.all<WindowRow>(queries.runs),
  ]);
  const rows = [
    ...jobRows.map((row) => ({ ...row, kind: "job" as const })),
    ...runRows.map((row) => ({ ...row, kind: "run" as const })),
  ];

  const envs = new Map<string, Environment>();
  const totals: Buckets = new Map();
  // repo + workflow -> { runs by env, job name -> buckets by env }
  const workflows = new Map<
    string,
    {
      repositoryId: number;
      repository: string;
      workflow: string | null;
      runs: Buckets;
      jobs: Map<string, Buckets>;
    }
  >();
  for (const row of rows) {
    const env = environmentFor(
      JSON.parse(row.labels) as string[],
      row.runner_group_name,
      row.machine_id,
    );
    if (!envs.has(env.key)) envs.set(env.key, env);
    const bucket = bucketOf(row);
    const id = `${row.repository_id}\u001f${row.workflow_name ?? ""}`;
    let workflow = workflows.get(id);
    if (!workflow) {
      workflow = {
        repositoryId: row.repository_id,
        repository: row.repository,
        workflow: row.workflow_name,
        runs: new Map(),
        jobs: new Map(),
      };
      workflows.set(id, workflow);
    }
    if (row.kind === "run") {
      add(workflow.runs, env.key, bucket);
      continue;
    }
    add(totals, env.key, bucket);
    const name = row.name ?? "";
    const jobBuckets = workflow.jobs.get(name) ?? new Map();
    add(jobBuckets, env.key, bucket);
    workflow.jobs.set(name, jobBuckets);
  }

  await nameMachines(db, workspaceId, envs);

  const leafStats: Record<string, Stat>[] = [];
  const workflowRows: WorkflowRow[] = [...workflows.values()].map((workflow) => {
    const leaves = new Map<string, JobRow>();
    const matrices = new Map<string, { buckets: Buckets; legs: JobRow[] }>();
    for (const [name, buckets] of workflow.jobs) {
      const row: JobRow = { name, byEnvironment: stats(buckets) };
      leafStats.push(row.byEnvironment);
      const base = matrixName(name);
      if (base) {
        const matrix = matrices.get(base) ?? { buckets: new Map(), legs: [] as JobRow[] };
        for (const [key, bucket] of buckets) add(matrix.buckets, key, bucket);
        matrix.legs.push(row);
        matrices.set(base, matrix);
      } else leaves.set(name, row);
    }
    // A lone leg stays a plain row: there's nothing to group.
    for (const [base, matrix] of matrices) {
      if (matrix.legs.length === 1) leaves.set(matrix.legs[0].name, matrix.legs[0]);
      else
        leaves.set(base, {
          name: base,
          byEnvironment: stats(matrix.buckets),
          legs: sortByRuns(matrix.legs),
        });
    }
    return {
      repositoryId: workflow.repositoryId,
      repository: workflow.repository,
      workflow: workflow.workflow,
      byEnvironment: stats(workflow.runs),
      jobs: sortByRuns([...leaves.values()]),
    };
  });

  const environments = [...envs.values()].map((env) => ({
    ...env,
    stat: statOf(totals.get(env.key) ?? emptyBucket()),
    versus: null as EnvironmentSummary["versus"],
  }));
  environments.sort((a, b) => b.stat.runs - a.stat.runs);
  // Linux 2-core is the yardstick most people know; otherwise the busiest environment.
  const baseline =
    environments.find((env) => env.key === "github:linux-2-core")?.key ??
    environments[0]?.key ??
    null;
  if (baseline)
    for (const env of environments)
      if (env.key !== baseline) env.versus = versusBaseline(leafStats, env.key, baseline);

  return {
    days,
    sampleCap: SAMPLE_CAP,
    baseline,
    environments,
    workflows: sortBy(workflowRows, (row) => row.jobs.reduce((sum, job) => sum + runsOf(job), 0)),
  };
}

function runsOf(row: { byEnvironment: Record<string, Stat> }) {
  return Object.values(row.byEnvironment).reduce((sum, stat) => sum + stat.runs, 0);
}

// Most first, each total worked out once.
function sortBy<T>(rows: T[], total: (row: T) => number) {
  const totals = new Map(rows.map((row) => [row, total(row)]));
  return rows.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
}

// Busiest first, then by name.
function sortByRuns(rows: JobRow[]) {
  return sortBy(
    rows.sort((a, b) => a.name.localeCompare(b.name)),
    runsOf,
  );
}

export interface JobRun {
  id: number;
  runId: number;
  runAttempt: number;
  environment: string;
  conclusion: string | null;
  queuedAt: number | null;
  startedAt: number;
  completedAt: number;
}

/**
 * One job's runs in the window, newest first, for the detail chart: a range of job_timing_job_idx.
 * `name` may be a matrix job's shared name, which takes in all its legs.
 */
export async function jobRuns(
  db: Db,
  workspaceId: string,
  job: { repositoryId: number; workflow: string | null; name: string; matrix: boolean },
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<{ days: number; runs: JobRun[] }> {
  const since = new Date(now - days * DAY_MS);
  const name = job.matrix
    ? // Every `name (…)`: a range on the index, unlike LIKE.
      and(gte(table.name, `${job.name} (`), sql`${table.name} < ${`${job.name} )`}`)
    : eq(table.name, job.name);
  const rows = await db
    .select({
      id: table.id,
      runId: table.runId,
      runAttempt: table.runAttempt,
      labels: table.labels,
      runnerGroupName: table.runnerGroupName,
      machineId: table.machineId,
      conclusion: table.conclusion,
      queuedAt: table.queuedAt,
      startedAt: table.startedAt,
      completedAt: table.completedAt,
    })
    .from(table)
    .where(
      and(
        eq(table.repositoryId, job.repositoryId),
        job.workflow === null ? isNull(table.workflowName) : eq(table.workflowName, job.workflow),
        name,
        gte(table.completedAt, since),
        inWorkspace(workspaceId),
        RAN,
      ),
    )
    .orderBy(sql`${table.completedAt} desc`)
    .limit(500);

  const runs = rows.flatMap((row): JobRun[] => {
    if (!row.startedAt || !row.completedAt) return [];
    return [
      {
        id: row.id,
        runId: row.runId,
        runAttempt: row.runAttempt,
        environment: environmentFor(row.labels, row.runnerGroupName, row.machineId).key,
        conclusion: row.conclusion,
        queuedAt: row.queuedAt?.getTime() ?? null,
        startedAt: row.startedAt.getTime(),
        completedAt: row.completedAt.getTime(),
      },
    ];
  });
  return { days, runs };
}

/**
 * Each of the workspace's machines' jobs in the window, for its card on the Runners page: a range
 * of the partial job_timing_machine_idx per machine, so only machine jobs are read.
 */
export async function machineJobTimes(
  db: Db,
  workspaceId: string,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<{ days: number; machines: Record<string, Stat> }> {
  const since = new Date(now - days * DAY_MS);
  const rows = await db.all<{
    machine_id: string;
    runs: number;
    successes: number;
    samples: string | null;
  }>(sql`
    select ${table.machineId} as machine_id, count(*) as runs, sum(${OK}) as successes,
      ${SAMPLES} as samples
    from ${table}
    where ${table.machineId} in (
        select ${schema.machine.id} from ${schema.machine}
        where ${schema.machine.workspaceId} = ${workspaceId})
      and ${table.completedAt} >= ${since.getTime()}
      and ${RAN}
    group by ${table.machineId}`);
  return {
    days,
    machines: Object.fromEntries(rows.map((row) => [row.machine_id, statOf(bucketOf(row))])),
  };
}
