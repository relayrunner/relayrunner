// The provider pages: what this workspace's jobs did on each provider over the last few days, in
// total and per runner type, with an estimated cost. Read from job_timing like Job times
// (src/job-times.ts), with the same rows, environments and sample buckets, so the numbers match
// that page and Runners.
//
// Database cost: one or two statements, each a range of job_timing_installation_idx (the
// workspace's installations, completed in the window), grouped by the columns environmentFor reads.
// The provider is worked out from each group's labels afterwards, since it's derived and not stored.
import {
  isProviderId,
  listRate,
  type PriceBook,
  PRICES_CHECKED,
  providerOfEnvironment,
  type RatePrices,
  ratePrices,
} from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { loadPriceBook } from "./prices.ts";
import { isCatalogProvider } from "./provider-catalog.ts";
import {
  BILLED_MINUTES,
  cents,
  classRate,
  DAY_MS,
  pricePeriods,
  runnerClass,
} from "./job-timings.ts";
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
  provider: string;
  days: number;
  /** When the list prices were last checked. */
  pricesChecked: string;
  /** Times across every runner type, from the newest successful runs. */
  stat: Stat;
  /** Busiest first. */
  runners: ProviderRunner[];
  /** The workflows with the most jobs here, busiest first, at most WORKFLOW_LIMIT. */
  workflows: ProviderWorkflow[];
  /** The provider's list prices, each with its history. Empty when it has none. */
  prices: RatePrices[];
}

export interface ProviderSummary extends ProviderCounts {
  provider: string;
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
  period: number;
  labels: string;
  runner_group_name: string | null;
  runs: number;
  successes: number;
  failures: number;
  billed_minutes: number;
  /** Of those, the jobs and minutes in public repos, where GitHub's standard runners are free. */
  public_runs: number;
  public_billed_minutes: number;
  samples: string | null;
}

// What a group adds up as it goes; jobs come from its bucket.
interface Sums {
  failures: number;
  billedMinutes: number;
  cost: number;
  unpricedJobs: number;
}

const zero = (): Sums => ({ failures: 0, billedMinutes: 0, cost: 0, unpricedJobs: 0 });

interface Group extends Sums {
  provider: string;
  env: Environment;
  perMinute: number | null;
  bucket: Bucket;
}

const FAILED = sql`coalesce(${table.conclusion} in ('failure', 'timed_out'), 0)`;
const PUBLIC = sql`coalesce(${repo.private} = 0, 0)`;

// Machines are never a provider, so their jobs are left out in SQL.
const where = (workspaceId: string, days: number, now: number) =>
  sql`${windowWhere(workspaceId, new Date(now - days * DAY_MS))} and ${table.machineId} is null`;

/**
 * What a minute cost on a runner type at `at`, in a private repo: GitHub's standard runners by the
 * Usage report's rates, the services by their list prices. Null when unknown, such as a larger
 * runner.
 */
function perMinuteOf(
  book: PriceBook,
  provider: string,
  env: Environment,
  labels: string[],
  runnerGroupName: string | null,
  at: number,
) {
  // Providers operators added have no list prices.
  if (!isProviderId(provider)) return null;
  if (provider !== "github") return listRate(book, provider, env.label, at);
  const cls = runnerClass(labels, runnerGroupName);
  return cls === "other" || cls === "self-hosted" ? null : classRate(book, cls, at);
}

// Every provider runner type the workspace's jobs used, by environment key. Several label sets
// can land on one (`ubuntu-latest` and `ubuntu-24.04`), and a price change in the window splits a
// label set in two, each priced at its own rate.
async function runnerGroups(db: Db, workspaceId: string, days: number, now: number) {
  const book = await loadPriceBook(db, now);
  const prices = pricePeriods(book, table.completedAt, now - days * DAY_MS, now);
  const rows = await db.all<Row>(sql`
    select ${prices.period} as period, ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      count(*) as runs, sum(${OK}) as successes, sum(${FAILED}) as failures,
      sum(${BILLED_MINUTES}) as billed_minutes, sum(${PUBLIC}) as public_runs,
      sum(case when ${PUBLIC} then ${BILLED_MINUTES} else 0 end) as public_billed_minutes,
      ${SAMPLES} as samples
    from ${table} left join ${repo} on ${repo.id} = ${table.repositoryId}
    where ${where(workspaceId, days, now)}
    group by ${sql.join([...prices.groupBy, table.labels, table.runnerGroupName], sql`, `)}`);

  const groups = new Map<string, Group>();
  for (const row of rows) {
    const labels = JSON.parse(row.labels) as string[];
    const env = environmentFor(labels, row.runner_group_name, null);
    const provider = providerOfEnvironment(env.key, isCatalogProvider);
    if (provider === "machine") continue;
    const rateAt = (at: number) =>
      perMinuteOf(book, provider, env, labels, row.runner_group_name, at);
    const perMinute = rateAt(prices.at(Number(row.period)));
    const billedMinutes = Number(row.billed_minutes);
    // GitHub's standard runners are free in public repos; the services charge either way.
    const charged =
      provider === "github" ? billedMinutes - Number(row.public_billed_minutes) : billedMinutes;
    // Shown at today's price.
    const group = groups.get(env.key) ?? {
      provider,
      env,
      perMinute: rateAt(now),
      ...zero(),
      bucket: emptyBucket(),
    };
    group.failures += Number(row.failures);
    group.billedMinutes += billedMinutes;
    if (perMinute === null) group.unpricedJobs += Number(row.runs);
    else group.cost += charged * perMinute;
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
  provider: string,
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
  // Label sets repeat across workflows, so each is classified once.
  const ours = new Map<string, boolean>();
  const workflows = new Map<string, ProviderWorkflow>();
  for (const row of rows) {
    const pair = `${row.labels}\u001f${row.runner_group_name}`;
    let mine = ours.get(pair);
    if (mine === undefined) {
      const env = environmentFor(JSON.parse(row.labels) as string[], row.runner_group_name, null);
      mine = providerOfEnvironment(env.key, isCatalogProvider) === provider;
      ours.set(pair, mine);
    }
    if (!mine) continue;
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
  provider: string,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<ProviderReport> {
  const [all, workflows, book] = await Promise.all([
    runnerGroups(db, workspaceId, days, now),
    busiestWorkflows(db, workspaceId, provider, days, now),
    loadPriceBook(db, now),
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
    prices: ratePrices(book, provider),
  };
}

/** Every provider the workspace's jobs ran on over the last `days` days, busiest first. */
export async function providersOverview(
  db: Db,
  workspaceId: string,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<ProvidersOverview> {
  const groups = await runnerGroups(db, workspaceId, days, now);
  const byProvider = Map.groupBy(groups, (group) => group.provider);
  const providers = [...byProvider].map(([provider, groups]) => ({
    provider,
    ...totalOf(groups),
  }));
  providers.sort((a, b) => b.jobs - a.jobs);
  return { days, pricesChecked: PRICES_CHECKED, providers };
}
