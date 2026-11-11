// The provider pages: what this workspace's jobs did on each provider over the last few days, in
// total and per runner type, with an estimated cost. Read from job_timing like Job times
// (src/job-times.ts), with the same rows, environments and sample buckets, so the numbers match
// that page and Runners.
//
// Database cost: one or two statements, each a range of job_timing_installation_idx (the
// workspace's installations, completed in the window), grouped by the columns environmentFor reads.
// The provider is worked out from each group's labels afterwards, since it's derived and not stored.
import {
  listRate,
  PRICES_CHECKED,
  type ProviderId,
  providerOfEnvironment,
} from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { cents, DAY_MS, RUNNER_RATES, type RunnerClass, rateFor } from "./job-timings.ts";
import {
  type Bucket,
  bucketOf,
  DEFAULT_DAYS,
  emptyBucket,
  type Environment,
  environmentFor,
  mergeInto,
  OK,
  SAMPLES,
  type Stat,
  statOf,
  windowWhere,
} from "./job-times.ts";

const table = schema.jobTiming;
const repo = schema.githubRepository;

export interface ProviderCounts {
  /** Jobs a runner finished, whatever their result. */
  jobs: number;
  /** Jobs that failed or timed out. Cancelled jobs count in neither. */
  failures: number;
  /** Time the jobs ran, start to finish. */
  runSeconds: number;
  /** Minutes after rounding each job up, as the services bill. */
  billedMinutes: number;
  /** Estimated USD at list price, for the jobs on runner types with a known price. */
  cost: number;
  /** Jobs on runner types without a known price, left out of `cost`. */
  unpricedJobs: number;
}

export interface ProviderRunner extends Environment, ProviderCounts {
  stat: Stat;
  /** USD per minute at list price (a private repo's, for GitHub), or null when unknown. */
  perMinute: number | null;
}

export interface ProviderWorkflow {
  repository: string;
  workflow: string;
  jobs: number;
}

export interface ProviderReport extends ProviderCounts {
  provider: ProviderId;
  days: number;
  /** When the list prices were last checked. */
  pricesChecked: string;
  /** Times across every runner type, from the newest successful runs. */
  stat: Stat;
  /** Busiest first. */
  runners: ProviderRunner[];
  /** The workflows with the most jobs here, busiest first, at most WORKFLOW_LIMIT. */
  workflows: ProviderWorkflow[];
}

export interface ProviderSummary extends ProviderCounts {
  provider: ProviderId;
  stat: Stat;
}

export interface ProvidersOverview {
  days: number;
  pricesChecked: string;
  /** Providers with jobs in the window, busiest first. */
  providers: ProviderSummary[];
}

const WORKFLOW_LIMIT = 5;

interface Row {
  labels: string;
  runner_group_name: string | null;
  private: number | null;
  runs: number;
  successes: number;
  failures: number;
  run_ms: number;
  billed_minutes: number;
  samples: string | null;
}

// What a group adds up as it goes; jobs come from its bucket.
interface Sums {
  failures: number;
  runMs: number;
  billedMinutes: number;
  cost: number;
  unpricedJobs: number;
}

const zero = (): Sums => ({ failures: 0, runMs: 0, billedMinutes: 0, cost: 0, unpricedJobs: 0 });

interface Group extends Sums {
  provider: ProviderId;
  env: Environment;
  perMinute: number | null;
  bucket: Bucket;
}

const FAILED = sql`coalesce(${table.conclusion} in ('failure', 'timed_out'), 0)`;
const DURATION = sql`max(0, ${table.completedAt} - ${table.startedAt})`;

// Machines are never a provider, so their jobs are left out in SQL.
const where = (workspaceId: string, days: number, now: number) =>
  sql`${windowWhere(workspaceId, new Date(now - days * DAY_MS))} and ${table.machineId} is null`;

/**
 * What a minute costs on a runner type: GitHub's standard runners by the Usage report's rates
 * (free in public repos), the services by their list prices. Null when unknown.
 */
function perMinuteOf(provider: ProviderId, env: Environment, isPrivate: boolean | null) {
  if (provider !== "github") return listRate(provider, env.label);
  const cls = env.key.slice("github:".length);
  return cls in RUNNER_RATES ? rateFor(cls as RunnerClass, isPrivate) : null;
}

// Every provider runner type the workspace's jobs used, by environment key. Several label sets
// can land on one (`ubuntu-latest` and `ubuntu-24.04`), as can public and private repos.
async function runnerGroups(db: Db, workspaceId: string, days: number, now: number) {
  const rows = await db.all<Row>(sql`
    select ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      ${repo.private} as private, count(*) as runs, sum(${OK}) as successes,
      sum(${FAILED}) as failures, sum(${DURATION}) as run_ms,
      sum(max(1, (${DURATION} + 59999) / 60000)) as billed_minutes, ${SAMPLES} as samples
    from ${table} left join ${repo} on ${repo.id} = ${table.repositoryId}
    where ${where(workspaceId, days, now)}
    group by ${table.labels}, ${table.runnerGroupName}, ${repo.private}`);

  const groups = new Map<string, Group>();
  for (const row of rows) {
    const env = environmentFor(JSON.parse(row.labels) as string[], row.runner_group_name, null);
    const provider = providerOfEnvironment(env.key);
    if (provider === "machine") continue;
    const isPrivate = row.private === null ? null : Boolean(row.private);
    const perMinute = perMinuteOf(provider, env, isPrivate);
    const billedMinutes = Number(row.billed_minutes);
    const group = groups.get(env.key) ?? {
      provider,
      env,
      perMinute: perMinuteOf(provider, env, true),
      ...zero(),
      bucket: emptyBucket(),
    };
    group.failures += Number(row.failures);
    group.runMs += Number(row.run_ms);
    group.billedMinutes += billedMinutes;
    if (perMinute === null) group.unpricedJobs += Number(row.runs);
    else group.cost += billedMinutes * perMinute;
    mergeInto(group.bucket, bucketOf(row));
    groups.set(env.key, group);
  }
  return [...groups.values()];
}

// Several groups' counts and times as one.
function totalOf(groups: Group[]) {
  const bucket = emptyBucket();
  const sums = zero();
  for (const group of groups) {
    mergeInto(bucket, group.bucket);
    for (const key of Object.keys(sums) as (keyof Sums)[]) sums[key] += group[key];
  }
  return countsOf(bucket, sums);
}

function countsOf(bucket: Bucket, c: Sums): ProviderCounts & { stat: Stat } {
  return {
    jobs: bucket.runs,
    failures: c.failures,
    runSeconds: Math.round(c.runMs / 1000),
    billedMinutes: c.billedMinutes,
    cost: cents(c.cost),
    unpricedJobs: c.unpricedJobs,
    stat: statOf(bucket),
  };
}

// The workflows with the most jobs on one provider.
async function busiestWorkflows(
  db: Db,
  workspaceId: string,
  provider: ProviderId,
  days: number,
  now: number,
): Promise<ProviderWorkflow[]> {
  const rows = await db.all<{
    labels: string;
    runner_group_name: string | null;
    repository: string;
    workflow: string;
    jobs: number;
  }>(sql`
    select ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      ${table.repositoryFullName} as repository, ${table.workflowName} as workflow,
      count(*) as jobs
    from ${table}
    where ${where(workspaceId, days, now)}
    group by ${table.labels}, ${table.runnerGroupName}, ${table.repositoryFullName},
      ${table.workflowName}`);
  const workflows = new Map<string, ProviderWorkflow>();
  for (const row of rows) {
    const env = environmentFor(JSON.parse(row.labels) as string[], row.runner_group_name, null);
    if (providerOfEnvironment(env.key) !== provider) continue;
    const key = `${row.repository}\u001f${row.workflow}`;
    const workflow = workflows.get(key) ?? {
      repository: row.repository,
      workflow: row.workflow,
      jobs: 0,
    };
    workflow.jobs += Number(row.jobs);
    workflows.set(key, workflow);
  }
  return [...workflows.values()]
    .sort((a, b) => b.jobs - a.jobs || a.workflow.localeCompare(b.workflow))
    .slice(0, WORKFLOW_LIMIT);
}

/** The workspace's jobs on one provider over the last `days` days. */
export async function providerReport(
  db: Db,
  workspaceId: string,
  provider: ProviderId,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<ProviderReport> {
  const [all, workflows] = await Promise.all([
    runnerGroups(db, workspaceId, days, now),
    busiestWorkflows(db, workspaceId, provider, days, now),
  ]);
  const groups = all.filter((group) => group.provider === provider);
  const runners: ProviderRunner[] = groups
    .map((group) => ({
      ...group.env,
      perMinute: group.perMinute,
      ...countsOf(group.bucket, group),
    }))
    .sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));
  return {
    provider,
    days,
    pricesChecked: PRICES_CHECKED,
    ...totalOf(groups),
    runners,
    workflows,
  };
}

/** Every provider the workspace's jobs ran on over the last `days` days, busiest first. */
export async function providersOverview(
  db: Db,
  workspaceId: string,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<ProvidersOverview> {
  const byProvider = new Map<ProviderId, Group[]>();
  for (const group of await runnerGroups(db, workspaceId, days, now))
    byProvider.set(group.provider, [...(byProvider.get(group.provider) ?? []), group]);
  const providers = [...byProvider].map(([provider, groups]) => ({
    provider,
    ...totalOf(groups),
  }));
  providers.sort((a, b) => b.jobs - a.jobs);
  return { days, pricesChecked: PRICES_CHECKED, providers };
}
