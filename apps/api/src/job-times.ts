// Job times: how long each workflow and job usually takes on each runner environment, over a
// rolling window, for the dashboard's Job times page. Read from job_timing (src/job-timings.ts),
// which already stores every finished job. Nothing is precomputed: the window is short, medians
// don't add up across days, and the per-job cap needs the samples anyway.
//
// Database cost: the summary is one statement, a range of job_timing_installation_idx (the
// workspace's installations, completed in the window), never a scan of the table. The detail is
// a range of job_timing_job_idx. job-times.test.ts checks the rows D1 reads.
import type { JobUsage } from "@relayrunner/machine-protocol";
import { and, eq, gte, inArray, isNotNull, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { type RunnerSize, runnerSize } from "@relayrunner/providers";
import { INSTANCE, usesContainerRunner } from "./container-runner.ts";
import { type Db, schema } from "./db/index.ts";
import { type Phase, phaseOf } from "./step-phases.ts";
import { DAY_MS, GITHUB_HOSTED_GROUP, RUNNER_LABELS, runnerClass } from "./job-timings.ts";
import {
  hasTrend,
  lastDays,
  type ReportWindow,
  type Window,
  windowDays,
  withPrior,
} from "./report-window.ts";
import { cloudProviderFor, isGitHubHostedLabel } from "./cloud-providers.ts";
import { inWorkspace as machineInWorkspace } from "./machines.ts";
import { currentProviders } from "./provider-catalog.ts";
import { routeIdFromLabels } from "./routing.ts";
import { type JobTypeKind, jobTypeKey, readJobTypes } from "./ai/job-type.ts";
import { RELAYRUNNER_LABEL } from "./labels.ts";

const table = schema.jobTiming;

/** Newest successful runs kept per job and environment, so a busy job reflects its latest code. */
export const SAMPLE_CAP = 50;
/** Under this many runs a time is shown greyed and never compared. */
export const FEW_RUNS = 5;
/** Under this many runs a time is low confidence. */
export const ENOUGH_RUNS = 20;
/** Shared jobs a runner needs before it's compared with the baseline: one job is an anecdote. */
export const MIN_SHARED_JOBS = 3;
export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 30;

export interface Environment {
  /** e.g. `github:linux-2-core`, `machine:<id>`, `container`. */
  key: string;
  label: string;
  detail: string;
  /** Its vCPUs and memory, when the label or the service says. */
  size?: RunnerSize;
  /**
   * `machine:<id>` only: how it joined (a `relayrunner connect` machine or a runner added from
   * GitHub) and the device it reported, so the dashboard can pick its icon.
   */
  machine?: { source: "connect" | "github"; kind: string | null; model: string | null };
}

// Adds the size runnerSize finds for a provider's label, when it finds one.
function sized(env: Environment, provider: string, label = env.label): Environment {
  const size = runnerSize(provider, label);
  return size ? { ...env, size } : env;
}

const MACHINE = "machine:";

// A runner group as GitHub shows it under a runner, or nothing for Default: repo-level runners have
// no group, and GitHub reports them as Default.
const groupDetail = (group: string) =>
  group.toLowerCase() === "default" ? "" : `Runner group: ${group}`;

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
    return sized(
      { key: "container", label: "Cloudflare Container", detail: INSTANCE },
      "cloudflare",
      INSTANCE,
    );
  const lower = labels.map((label) => label.toLowerCase());
  // Including the ones operators added in the admin (routes load them with withCatalog).
  const provider = cloudProviderFor(lower, currentProviders());
  if (provider)
    return sized(
      { key: `${provider.id}:${provider.label}`, label: provider.label, detail: provider.name },
      provider.id,
    );
  const group = runnerGroupName || "Default";
  // Asked for by name: a `self-hosted` label, a pick, or a route to a machine. GitHub matches group
  // names without case, so `default` and `Default` are one row.
  if (
    lower.includes("self-hosted") ||
    lower.includes(RELAYRUNNER_LABEL) ||
    routeIdFromLabels(labels)
  )
    return {
      key: `self-hosted:${group.toLowerCase()}`,
      label: "Self-hosted",
      detail: groupDetail(group),
    };
  if (lower.some(isGitHubHostedLabel) || runnerGroupName === GITHUB_HOSTED_GROUP) {
    const cls = runnerClass(labels, runnerGroupName);
    if (cls !== "other" && cls !== "self-hosted")
      return sized(
        { key: `github:${cls}`, label: RUNNER_LABELS[cls], detail: "GitHub-hosted" },
        "github",
        cls,
      );
    // A larger runner or an image without a standard price: named by its label.
    const label = lower[0] ?? "unknown";
    return sized({ key: `github:${label}`, label, detail: "GitHub-hosted" }, "github");
  }
  // A label nothing above recognises: another service, or a self-hosted runner asked for only by
  // its custom labels.
  const label = lower[0] ?? "unknown";
  return sized(
    {
      key: `other:${label}`,
      label,
      // A runner in an org group is self-hosted, even when nothing knows its labels.
      detail: runnerGroupName
        ? groupDetail(runnerGroupName) || "Self-hosted"
        : "Unrecognized label",
    },
    "other",
  );
}

/** Who runs an environment: `machine`, `github`, `self-hosted`, `container`, a provider's id... */
export const environmentProvider = (env: Environment) => env.key.split(":")[0]!;

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
      source: schema.machine.source,
      kind: schema.machine.deviceKind,
      model: schema.machine.deviceModel,
      chip: schema.machine.chip,
      os: schema.machine.os,
      vmCpus: schema.machine.vmCpus,
      vmMemoryGb: schema.machine.vmMemoryGb,
      isolatedOs: schema.machine.isolatedOs,
    })
    .from(schema.machine)
    .where(and(machineInWorkspace(db, workspaceId), inArray(schema.machine.id, machineIds)));
  for (const machine of machines) {
    const env = envs.get(`${MACHINE}${machine.id}`);
    if (!env) continue;
    env.label = machine.name;
    env.machine = {
      source: machine.source === "github" ? "github" : "connect",
      kind: machine.kind,
      model: machine.model,
    };
    env.detail = [machine.model, machine.chip].filter(Boolean).join(" · ") || (machine.os ?? "");
    // Every job runs in a VM of this size, as of its last connect. With --macos some run on the
    // Mac itself, so the size wouldn't say which.
    if (machine.vmCpus && !machine.isolatedOs)
      env.size = {
        vcpus: machine.vmCpus,
        ...(machine.vmMemoryGb && { memoryGb: machine.vmMemoryGb }),
      };
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
  p90Ms: number | null;
  /** Median wait from queued to started. Null for rows from before it was stored. */
  waitMs: number | null;
  /**
   * The median against the previous window of the same length, as a fraction (0.18 is 18%
   * slower). Null when either window has under FEW_RUNS samples, or nothing was compared.
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

/** How much slower `now` is than `before` as a fraction, when both have FEW_RUNS+ samples. */
function trendOf(now: Sample[], before: Sample[] | undefined) {
  if (!before || now.length < FEW_RUNS || before.length < FEW_RUNS) return null;
  const recent = medianRun(now);
  const older = medianRun(newestOf([...before]));
  return recent !== null && older ? Math.round(((recent - older) / older) * 100) / 100 : null;
}

/**
 * Times from a bucket's newest SAMPLE_CAP successful runs (kept newest first by mergeInto), with
 * the trend against `prior`, the same runs in the window before.
 */
export function statOf(bucket: Bucket, prior?: Bucket): Stat {
  const newest = newestOf([...bucket.samples]);
  const runs = newest.map((s) => s.runMs).sort(ascending);
  const waits = newest
    .map((s) => s.waitMs)
    .filter((ms): ms is number => ms !== null)
    .sort(ascending);
  const trend = trendOf(newest, prior?.samples);
  return {
    runs: bucket.runs,
    successes: bucket.successes,
    samples: newest.length,
    confidence: confidence(newest.length),
    medianMs: quantile(runs, 0.5),
    p90Ms: quantile(runs, 0.9),
    waitMs: quantile(waits, 0.5),
    trend,
  };
}

export interface EnvironmentSummary extends Environment {
  stat: Stat;
  /**
   * Jobs sent here that no runner picked up (NOT_PICKED_UP). With `stat.runs`, the share it
   * started, which says how reliable the runner is whatever the jobs' own results.
   */
  missed: number;
  /**
   * Against the baseline on the jobs both ran FEW_RUNS+ times: the median of this environment's
   * median over the baseline's (0.5 is twice as fast). Null for the baseline itself or with under
   * MIN_SHARED_JOBS shared jobs.
   */
  versus: { ratio: number; sharedJobs: number } | null;
}

export interface JobRow {
  name: string;
  byEnvironment: Record<string, Stat>;
  /** Matrix legs (`test (node 24)`), when this row groups them under their shared name. */
  legs?: JobRow[];
  /** What the job does, from the AI model (src/ai/job-type.ts), once it has read the job. */
  type?: JobTypeKind;
}

export interface WorkflowRow {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  jobs: JobRow[];
}

export interface JobTimesReport {
  days: number;
  /** Whether times carry a trend against the window before (hasTrend in report-window.ts). */
  trend: boolean;
  sampleCap: number;
  /** Runs a job needs on both runners to count toward `versus`. */
  fewRuns: number;
  /** Shared jobs a runner needs before it gets a `versus`. */
  minSharedJobs: number;
  baseline: string | null;
  environments: EnvironmentSummary[];
  workflows: WorkflowRow[];
}

interface WindowRow {
  repository_id: number;
  repository: string;
  workflow_name: string | null;
  name: string;
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
/** A job that failed or timed out. Cancelled jobs are neither this nor OK. */
export const FAILED = sql`coalesce(${table.conclusion} in ('failure', 'timed_out'), 0)`;

// How long a job waits with no runner before it counts as missed. Shorter waits are left out, since
// a concurrency group or a person cancels those.
export const MISSED_AFTER_MS = 10 * 60_000;

/** A job no runner took: it finished (GitHub gave up, or it was cancelled) after a long wait. */
export const NOT_PICKED_UP = sql`(${table.startedAt} is null or ${table.runnerName} is null)
  and coalesce(${table.conclusion}, '') <> 'skipped' and not ${PICK}
  and ${table.completedAt} - ${table.queuedAt} >= ${MISSED_AFTER_MS}`;

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
    select ${schema.workspace.installationId} from ${schema.workspace}
    where ${schema.workspace.id} = ${workspaceId})`;
}

/** The jobs a report counts: the workspace's, finished since `since`, run by a runner, not picks. */
/** Before `until` (epoch ms), when the window ends before now. */
const before = (until?: number) =>
  until === undefined ? sql`` : sql` and ${table.completedAt} < ${until}`;

export const windowWhere = (workspaceId: string, since: Date, until?: number) =>
  sql`${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since.getTime()}${before(until)}
    and ${RAN}`;

/**
 * The window's aggregate, a single range read of job_timing_installation_idx: the workspace's
 * installations, completed since `since`. Measured on D1, it reads about 2 rows per row in the
 * window (the range plus SQLite's GROUP BY sorter, which D1 counts too), however big the table
 * is. A single statement over a MATERIALIZED window with row_number() caps reads more, since D1
 * also counts the temp table and the window sorts, so the SAMPLE_CAP cut happens in TypeScript.
 */
export function windowQuery(workspaceId: string, since: Date, until?: number) {
  return sql`
    select ${table.repositoryId} as repository_id, min(${table.repositoryFullName}) as repository,
      ${table.workflowName} as workflow_name, ${table.name} as name, ${table.labels} as labels,
      ${table.runnerGroupName} as runner_group_name, ${table.machineId} as machine_id,
      count(*) as runs, sum(${OK}) as successes, ${SAMPLES} as samples
    from ${table} where ${windowWhere(workspaceId, since, until)}
    group by ${table.repositoryId}, ${table.workflowName}, ${table.name}, ${table.labels},
      ${table.runnerGroupName}, ${table.machineId}`;
}

/** The window's missed jobs (NOT_PICKED_UP) by where they were sent, from the same index range. */
export function missedQuery(workspaceId: string, since: Date, until?: number) {
  return sql`
    select ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      ${table.machineId} as machine_id, count(*) as missed
    from ${table}
    where ${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since.getTime()}
      ${before(until)} and ${NOT_PICKED_UP}
    group by ${table.labels}, ${table.runnerGroupName}, ${table.machineId}`;
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
export function matrixName(name: string) {
  const at = name.indexOf(" (");
  return at > 0 && name.endsWith(")") ? name.slice(0, at) : null;
}

type Buckets = Map<string, Bucket>;

function add(buckets: Buckets, envKey: string, bucket: Bucket) {
  const into = buckets.get(envKey) ?? emptyBucket();
  mergeInto(into, bucket);
  buckets.set(envKey, into);
}

function stats(buckets: Buckets, prior?: Buckets): Record<string, Stat> {
  return Object.fromEntries(
    [...buckets].map(([key, bucket]) => [key, statOf(bucket, prior?.get(key))]),
  );
}

type WorkflowBuckets = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  jobs: Map<string, Buckets>;
};

/** The window's rows as buckets by environment: in total, and per workflow and job. */
function collect(rows: WindowRow[], envs: Map<string, Environment>) {
  const totals: Buckets = new Map();
  // repo + workflow -> job name -> buckets by env
  const workflows = new Map<string, WorkflowBuckets>();
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
        jobs: new Map(),
      };
      workflows.set(id, workflow);
    }
    add(totals, env.key, bucket);
    const jobBuckets = workflow.jobs.get(row.name) ?? new Map();
    add(jobBuckets, env.key, bucket);
    workflow.jobs.set(row.name, jobBuckets);
  }
  return { totals, workflows };
}

/** A matrix job's buckets: its legs' merged. */
function matrixBuckets(jobs: Map<string, Buckets> | undefined, base: string) {
  const merged: Buckets = new Map();
  for (const [name, buckets] of jobs ?? [])
    if (matrixName(name) === base) for (const [key, bucket] of buckets) add(merged, key, bucket);
  return merged;
}

/**
 * Against the baseline on shared jobs: the median of the median ratios over every leaf job that ran
 * FEW_RUNS+ times on both, so one job with a cold cache or a different workload can't swing it.
 * Null under MIN_SHARED_JOBS shared jobs.
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
  if (logs.length < MIN_SHARED_JOBS) return null;
  // In log space, so with an even count 2× faster and 2× slower meet at even. Not quantile(),
  // which rounds to whole milliseconds.
  logs.sort(ascending);
  const middle = logs.length / 2;
  const log = logs.length % 2 ? logs[Math.floor(middle)] : (logs[middle - 1] + logs[middle]) / 2;
  return { ratio: Math.round(Math.exp(log) * 100) / 100, sharedJobs: logs.length };
}

/** The workspace's job times in the window, with a trend against its prior window. */
export async function jobTimesReport(
  db: Db,
  workspaceId: string,
  window: ReportWindow = withPrior(lastDays(DEFAULT_DAYS)),
  now = Date.now(),
): Promise<JobTimesReport> {
  const since = new Date(window.from);
  const trend = hasTrend(window, now);
  const [rows, missedRows, priorRows] = await Promise.all([
    db.all<WindowRow>(windowQuery(workspaceId, since, window.to)),
    db.all<{
      labels: string;
      runner_group_name: string | null;
      machine_id: string | null;
      missed: number;
    }>(missedQuery(workspaceId, since, window.to)),
    // The window before, for each time's trend: the same read again, a range just as long.
    trend
      ? db.all<WindowRow>(windowQuery(workspaceId, new Date(window.prior.from), window.prior.to))
      : Promise.resolve([]),
  ]);

  const envs = new Map<string, Environment>();
  // A runner that missed every job it was sent still gets a row: that's when it matters most.
  const missed = new Map<string, number>();
  for (const row of missedRows) {
    const env = environmentFor(
      JSON.parse(row.labels) as string[],
      row.runner_group_name,
      row.machine_id,
    );
    if (!envs.has(env.key)) envs.set(env.key, env);
    missed.set(env.key, (missed.get(env.key) ?? 0) + Number(row.missed));
  }
  const { totals, workflows } = collect(rows, envs);
  // Runners seen only in the window before don't get a row.
  const prior = trend ? collect(priorRows, new Map()) : null;

  const [types] = await Promise.all([
    readJobTypes(db, workspaceId),
    nameMachines(db, workspaceId, envs),
  ]);

  const leafStats: Record<string, Stat>[] = [];
  const workflowRows: WorkflowRow[] = [...workflows].map(([id, workflow]) => {
    const priorJobs = prior?.workflows.get(id)?.jobs;
    const leaves = new Map<string, JobRow>();
    const matrices = new Map<string, { buckets: Buckets; legs: JobRow[] }>();
    for (const [name, buckets] of workflow.jobs) {
      const type = types.get(jobTypeKey(workflow.repositoryId, workflow.workflow, name));
      const row: JobRow = {
        name,
        byEnvironment: stats(buckets, priorJobs?.get(name)),
        ...(type && { type }),
      };
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
          ...(matrix.legs[0].type && { type: matrix.legs[0].type }),
          byEnvironment: stats(matrix.buckets, priorJobs && matrixBuckets(priorJobs, base)),
          legs: sortByRuns(matrix.legs),
        });
    }
    return {
      repositoryId: workflow.repositoryId,
      repository: workflow.repository,
      workflow: workflow.workflow,
      jobs: sortByRuns([...leaves.values()]),
    };
  });

  const environments = [...envs.values()].map((env) => ({
    ...env,
    stat: statOf(totals.get(env.key) ?? emptyBucket(), prior?.totals.get(env.key)),
    missed: missed.get(env.key) ?? 0,
    versus: null as EnvironmentSummary["versus"],
  }));
  environments.sort((a, b) => b.stat.runs - a.stat.runs);
  // ubuntu-latest is the yardstick most people know; otherwise the busiest environment.
  const baseline =
    environments.find((env) => env.key === "github:linux-2-core")?.key ??
    environments[0]?.key ??
    null;
  if (baseline)
    for (const env of environments)
      if (env.key !== baseline) env.versus = versusBaseline(leafStats, env.key, baseline);

  return {
    days: windowDays(window),
    trend,
    sampleCap: SAMPLE_CAP,
    fewRuns: FEW_RUNS,
    minSharedJobs: MIN_SHARED_JOBS,
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

export const JOB_RUN_COLUMNS = {
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
};

type JobRunRow = Pick<typeof table.$inferSelect, keyof typeof JOB_RUN_COLUMNS>;

export function jobRunOf(row: JobRunRow, env?: Environment): JobRun | null {
  if (!row.startedAt || !row.completedAt) return null;
  return {
    id: row.id,
    runId: row.runId,
    runAttempt: row.runAttempt,
    environment: (env ?? environmentFor(row.labels, row.runnerGroupName, row.machineId)).key,
    conclusion: row.conclusion,
    queuedAt: row.queuedAt?.getTime() ?? null,
    startedAt: row.startedAt.getTime(),
    completedAt: row.completedAt.getTime(),
  };
}

/** A job in the History page's job list: a run of one job, with what it belongs to. */
export interface HistoryJob extends JobRun {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  name: string;
  /** The run's commit and who started the run, from workflow_run. Null for runs without one. */
  sha: string | null;
  actor: string | null;
  /** The run's branch and pull request, and the PR or commit title GitHub shows for it. */
  branch: string | null;
  pullRequest: number | null;
  title: string | null;
  /** The CPU and memory it used, when its machine reported them. */
  usage?: JobUsage;
}

const workflowRun = schema.workflowRun;

/**
 * Jobs as a job list shows them, newest finished first, at most `limit`, with their run's commit,
 * branch and pull request. The limit applies before the join, so only the listed jobs look up their
 * run.
 */
export function jobListQuery(db: Db, where: SQL, limit: number) {
  const jobs = db
    .select({
      ...JOB_RUN_COLUMNS,
      repositoryId: table.repositoryId,
      repository: table.repositoryFullName,
      workflow: table.workflowName,
      name: table.name,
      usage: table.usage,
    })
    .from(table)
    .where(where)
    .orderBy(sql`${table.completedAt} desc`)
    .limit(limit)
    .as("jobs");
  return db
    .select({
      ...jobs._.selectedFields,
      sha: workflowRun.headSha,
      actor: workflowRun.actorLogin,
      branch: workflowRun.headBranch,
      pullRequest: workflowRun.pullRequestNumber,
      title: workflowRun.displayTitle,
    })
    .from(jobs)
    .leftJoin(
      workflowRun,
      and(eq(workflowRun.id, jobs.runId), eq(workflowRun.runAttempt, jobs.runAttempt)),
    )
    .orderBy(sql`${jobs.completedAt} desc`);
}

type JobListRow = Awaited<ReturnType<typeof jobListQuery>>[number];

/** A job list's row, or null for a job no runner finished. */
export function historyJobOf(row: JobListRow, env?: Environment): HistoryJob | null {
  const run = jobRunOf(row, env);
  if (!run) return null;
  // The run's converted fields replace the raw ones; labels and the like only made `run`.
  const { labels: _l, runnerGroupName: _g, machineId: _m, usage, ...rest } = row;
  return { ...rest, ...run, ...(usage && { usage }) };
}

/** Most jobs the job list returns. */
const JOB_LIMIT = 500;

/**
 * The workspace's jobs a runner finished in the window, newest first, at most JOB_LIMIT, for the
 * History page's job list: one range of job_timing_installation_idx, read newest first.
 */
export async function recentJobs(
  db: Db,
  workspaceId: string,
  window: Window = lastDays(DEFAULT_DAYS),
): Promise<{ days: number; environments: Environment[]; jobs: HistoryJob[]; truncated: boolean }> {
  const where = windowWhere(workspaceId, new Date(window.from), window.to);
  const rows = await jobListQuery(db, where, JOB_LIMIT + 1);
  const days = windowDays(window);

  const envs = new Map<string, Environment>();
  const jobs = rows.slice(0, JOB_LIMIT).flatMap((row): HistoryJob[] => {
    const env = environmentFor(row.labels, row.runnerGroupName, row.machineId);
    const job = historyJobOf(row, env);
    if (!job) return [];
    if (!envs.has(env.key)) envs.set(env.key, env);
    return [job];
  });
  await nameMachines(db, workspaceId, envs);
  return { days, environments: [...envs.values()], jobs, truncated: rows.length > JOB_LIMIT };
}

/**
 * One job's runs in the window, newest first, for the detail chart: a range of job_timing_job_idx.
 * `name` may be a matrix job's shared name, which takes in all its legs.
 */
export async function jobRuns(
  db: Db,
  workspaceId: string,
  job: { repositoryId: number; workflow: string | null; name: string; matrix: boolean },
  window: Window = lastDays(DEFAULT_DAYS),
): Promise<{ days: number; runs: JobRun[]; steps: RunStep[] }> {
  const days = windowDays(window);
  const name = job.matrix
    ? // Every `name (…)`: a range on the index, unlike LIKE.
      and(gte(table.name, `${job.name} (`), sql`${table.name} < ${`${job.name} )`}`)
    : eq(table.name, job.name);
  const where = and(
    eq(table.repositoryId, job.repositoryId),
    job.workflow === null ? isNull(table.workflowName) : eq(table.workflowName, job.workflow),
    name,
    gte(table.completedAt, new Date(window.from)),
    lt(table.completedAt, new Date(window.to)),
    inWorkspace(workspaceId),
    RAN,
  );
  const [rows, steps] = await Promise.all([
    db
      .select(JOB_RUN_COLUMNS)
      .from(table)
      .where(where)
      .orderBy(sql`${table.completedAt} desc`)
      .limit(500),
    averageSteps(db, where),
  ]);
  const runs = rows.flatMap((row) => {
    const run = jobRunOf(row);
    return run ? [run] : [];
  });
  return { days, runs, steps };
}

/** A step of a job's average successful run. */
export interface RunStep {
  name: string;
  phase: Phase;
  ms: number;
}

/**
 * The average time of each step over the successful runs in `where` that reported steps, in the
 * order steps run. Failed runs stop early, so like the medians they're left out. A step a run
 * skipped counts as no time for it.
 */
async function averageSteps(db: Db, where: SQL | undefined): Promise<RunStep[]> {
  const ok = and(where, eq(table.conclusion, "success"), isNotNull(table.steps));
  const rows = await db.all<{ name: string; seconds: number; runs: number; at: number }>(sql`
    select step.value ->> 0 as name, sum(step.value ->> 1) as seconds, min(step.key) as at,
      (select count(*) from ${table} where ${ok}) as runs
    from ${table}, json_each(${table.steps}) as step
    where ${ok}
    group by step.value ->> 0
    order by at`);
  return rows.map((row) => ({
    name: row.name,
    phase: phaseOf(row.name),
    ms: Math.round((Number(row.seconds) * 1000) / Number(row.runs)),
  }));
}

/**
 * The jobs machines ran in the window, `machines` being a subquery of their ids: a range of the
 * partial job_timing_machine_idx per machine, so only machine jobs are read. A member's machine
 * also runs other workspaces' jobs (#318), so only this workspace's installation counts.
 */
export const machineWindowWhere = (
  workspaceId: string,
  machines: SQL,
  since: Date,
  until?: number,
) =>
  sql`${table.machineId} in (${machines})
    and ${table.installationId} = (
      select ${schema.workspace.installationId} from ${schema.workspace}
      where ${schema.workspace.id} = ${workspaceId})
    and ${table.completedAt} >= ${since.getTime()}${before(until)}
    and ${RAN}`;

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
  const machines = sql`select ${schema.machine.id} from ${schema.machine}
    where ${machineInWorkspace(db, workspaceId)}`;
  const rows = await db.all<{
    machine_id: string;
    runs: number;
    successes: number;
    samples: string | null;
  }>(sql`
    select ${table.machineId} as machine_id, count(*) as runs, sum(${OK}) as successes,
      ${SAMPLES} as samples
    from ${table}
    where ${machineWindowWhere(workspaceId, machines, since)}
    group by ${table.machineId}`);
  return {
    days,
    machines: Object.fromEntries(rows.map((row) => [row.machine_id, statOf(bucketOf(row))])),
  };
}

/** A job a typical time is asked for: one job of one workflow, on one runner environment. */
export interface TypicalJobKey {
  repositoryId: number;
  workflow: string | null;
  /** The job's name as GitHub shows it: a matrix leg is its own job (`test (node 24)`). */
  name: string;
  /** Its environment key (environmentFor), such as `machine:<id>` or `github:linux-2-core`. */
  environment: string;
}

/**
 * How long a job usually takes on an environment: the median and p90 of its newest SAMPLE_CAP
 * successful runs there over DEFAULT_DAYS, as on the Job times page.
 */
export interface TypicalTime {
  medianMs: number;
  p90Ms: number;
  /** Successful runs behind it: FEW_RUNS at least, at most SAMPLE_CAP. */
  samples: number;
}

/** The key typicalJobTimes' map uses for a job. */
export const typicalKey = (job: TypicalJobKey) =>
  [job.repositoryId, job.workflow ?? "", job.name, job.environment].join("\u001f");

// Jobs per statement: three bound values each, under D1's 100 per statement.
const TYPICAL_CHUNK = 25;

/**
 * Each job's typical time on its environment, keyed by typicalKey. A job with under FEW_RUNS
 * successful runs there in the window has no entry, since a time that thin isn't worth comparing
 * with. Each statement is a range of job_timing_job_idx per distinct job, never a scan.
 */
export async function typicalJobTimes(
  db: Db,
  workspaceId: string,
  jobs: TypicalJobKey[],
  now = Date.now(),
): Promise<Map<string, TypicalTime>> {
  const typical = new Map<string, TypicalTime>();
  const wanted = new Set(jobs.map(typicalKey));
  // One lookup per job, whatever environments it's asked for on.
  const distinct = [
    ...new Map(jobs.map((job) => [typicalKey({ ...job, environment: "" }), job] as const)).values(),
  ];
  if (!distinct.length) return typical;
  const since = now - DEFAULT_DAYS * DAY_MS;
  const chunks: TypicalJobKey[][] = [];
  for (let i = 0; i < distinct.length; i += TYPICAL_CHUNK)
    chunks.push(distinct.slice(i, i + TYPICAL_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => {
      const which = sql.join(
        chunk.map(
          (job) =>
            sql`(${table.repositoryId} = ${job.repositoryId} and ${
              job.workflow === null
                ? sql`${table.workflowName} is null`
                : sql`${table.workflowName} = ${job.workflow}`
            } and ${table.name} = ${job.name})`,
        ),
        sql` or `,
      );
      return db.all<Omit<WindowRow, "repository">>(sql`
        select ${table.repositoryId} as repository_id, ${table.workflowName} as workflow_name,
          ${table.name} as name, ${table.labels} as labels,
          ${table.runnerGroupName} as runner_group_name, ${table.machineId} as machine_id,
          count(*) as runs, sum(${OK}) as successes, ${SAMPLES} as samples
        from ${table}
        where (${which}) and ${table.completedAt} >= ${since} and ${inWorkspace(workspaceId)}
          and ${RAN}
        group by ${table.repositoryId}, ${table.workflowName}, ${table.name}, ${table.labels},
          ${table.runnerGroupName}, ${table.machineId}`);
    }),
  );
  const buckets: Buckets = new Map();
  for (const row of results.flat()) {
    const environment = environmentFor(
      JSON.parse(row.labels) as string[],
      row.runner_group_name,
      row.machine_id,
    ).key;
    const key = typicalKey({
      repositoryId: Number(row.repository_id),
      workflow: row.workflow_name,
      name: row.name,
      environment,
    });
    if (wanted.has(key)) add(buckets, key, bucketOf(row));
  }
  for (const [key, bucket] of buckets) {
    const stat = statOf(bucket);
    if (stat.samples >= FEW_RUNS && stat.medianMs !== null && stat.p90Ms !== null)
      typical.set(key, { medianMs: stat.medianMs, p90Ms: stat.p90Ms, samples: stat.samples });
  }
  return typical;
}

/**
 * One job's typical time on one of the workspace's machines, or null under FEW_RUNS successful
 * runs there. For what a machine is handed with a job, so it can show elapsed against usual.
 */
export async function typicalJobTime(
  db: Db,
  workspaceId: string,
  job: { repositoryId: number; workflow: string | null; name: string; machineId: string },
  now = Date.now(),
): Promise<TypicalTime | null> {
  const { machineId, ...rest } = job;
  const key = { ...rest, environment: `${MACHINE}${machineId}` };
  const times = await typicalJobTimes(db, workspaceId, [key], now);
  return times.get(typicalKey(key)) ?? null;
}
