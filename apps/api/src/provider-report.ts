// The provider pages: what this workspace's jobs did on each provider over the last few days, in
// total and per runner type, with an estimated cost. Read from job_timing like Job times
// (src/job-times.ts), with the same rows, environments and sample buckets, so the numbers match
// that page and Runners.
//
// Database cost: one or two statements, each a range of job_timing_installation_idx (the
// workspace's installations, completed in the window), grouped by the columns environmentFor reads.
// The provider is worked out from each group's labels afterwards, since it's derived and not stored.
import {
  ADDED_RATE,
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
import { hasTrend, type ReportWindow, type Window, windowDays } from "./report-window.ts";
import { DAY_MS } from "./time.ts";
import { BILLED_MINUTES, cents, classRate, pricePeriods, runnerClass } from "./job-timings.ts";
import {
  type Bucket,
  bucketOf,
  emptyBucket,
  type Environment,
  FAILED,
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
  /** Jobs with a known wait between queued and started. */
  waits: number;
  /** Of those, the jobs a runner started within QUICK_START_MS. */
  quickStarts: number;
  /** Failed jobs the runner gave up on before any step ran, such as a runner that never came up. */
  runnerFailures: number;
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
  /** Its runner types, busiest first. */
  runners: ProviderRunner[];
  /** Billed minutes in the window the trend compares with, or null when job_timing doesn't reach it. */
  priorBilledMinutes: number | null;
}

/** Billed minutes per provider in one stretch of the window. */
export interface ShareBucket {
  /** Epoch ms. */
  start: number;
  minutes: Record<string, number>;
}

export interface ProvidersOverview {
  days: number;
  pricesChecked: string;
  /** Providers with jobs in the window, busiest first. */
  providers: ProviderSummary[];
  /** How long each of `buckets` is: a day, or a week past a month. */
  bucketMs: number;
  /** Each provider's billed minutes over the window, oldest first. */
  buckets: ShareBucket[];
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
  waits: number;
  quick_starts: number;
  runner_failures: number;
  samples: string | null;
}

// What a group adds up as it goes; jobs come from its bucket.
interface Sums {
  failures: number;
  billedMinutes: number;
  cost: number;
  unpricedJobs: number;
  waits: number;
  quickStarts: number;
  runnerFailures: number;
}

const zero = (): Sums => ({
  failures: 0,
  billedMinutes: 0,
  cost: 0,
  unpricedJobs: 0,
  waits: 0,
  quickStarts: 0,
  runnerFailures: 0,
});

/** A job a runner started this soon after it queued counts as a quick start. */
export const QUICK_START_MS = 60_000;

const WAIT = sql`${table.startedAt} - ${table.queuedAt}`;

interface Group extends Sums {
  provider: string;
  env: Environment;
  perMinute: number | null;
  bucket: Bucket;
}

const PUBLIC = sql`coalesce(${repo.private} = 0, 0)`;

// Machines are never a provider, so their jobs are left out in SQL.
const where = (workspaceId: string, { from, to }: Window) =>
  sql`${windowWhere(workspaceId, new Date(from), to)} and ${table.machineId} is null`;

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
  // Providers operators added have one price a minute for any runner (admin Prices).
  if (!isProviderId(provider)) return book.usd(provider, ADDED_RATE, at);
  if (provider !== "github") return listRate(book, provider, env.label, at);
  const cls = runnerClass(labels, runnerGroupName);
  return cls === "other" || cls === "self-hosted" ? null : classRate(book, cls, at);
}

// Every provider runner type the workspace's jobs used, by environment key. Several label sets
// can land on one (`ubuntu-latest` and `ubuntu-24.04`), and a price change in the window splits a
// label set in two, each priced at its own rate.
async function runnerGroups(db: Db, workspaceId: string, window: Window, now: number) {
  const book = await loadPriceBook(db, now);
  const prices = pricePeriods(book, table.completedAt, window.from, window.to);
  const rows = await db.all<Row>(sql`
    select ${prices.period} as period, ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      count(*) as runs, sum(${OK}) as successes, sum(${FAILED}) as failures,
      sum(${BILLED_MINUTES}) as billed_minutes, sum(${PUBLIC}) as public_runs,
      sum(case when ${PUBLIC} then ${BILLED_MINUTES} else 0 end) as public_billed_minutes,
      sum(${table.queuedAt} is not null) as waits,
      sum(coalesce(${WAIT} < ${QUICK_START_MS}, 0)) as quick_starts,
      sum(coalesce(${table.ranSteps} = 0 and ${table.conclusion} = 'failure', 0)) as runner_failures,
      ${SAMPLES} as samples
    from ${table} left join ${repo} on ${repo.id} = ${table.repositoryId}
    where ${where(workspaceId, window)}
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
    group.waits += Number(row.waits);
    group.quickStarts += Number(row.quick_starts);
    group.runnerFailures += Number(row.runner_failures);
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

// Each group as a runner type, busiest first.
function runnersOf(groups: Group[]): ProviderRunner[] {
  return groups
    .map((group) => ({
      ...group.env,
      perMinute: group.perMinute,
      ...countsOf(group.bucket, group),
    }))
    .sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));
}

function countsOf(bucket: Bucket, c: Sums): ProviderCounts & { stat: Stat } {
  return {
    jobs: bucket.runs,
    failures: c.failures,
    billedMinutes: c.billedMinutes,
    cost: cents(c.cost),
    unpricedJobs: c.unpricedJobs,
    waits: c.waits,
    quickStarts: c.quickStarts,
    runnerFailures: c.runnerFailures,
    stat: statOf(bucket),
  };
}

// The workflows with the most jobs on one provider.
async function busiestWorkflows(
  db: Db,
  workspaceId: string,
  provider: string,
  window: Window,
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
    where ${where(workspaceId, window)}
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

/** The workspace's jobs on one provider in the window. */
export async function providerReport(
  db: Db,
  workspaceId: string,
  provider: string,
  window: Window,
  now = Date.now(),
): Promise<ProviderReport> {
  const [all, workflows, book] = await Promise.all([
    runnerGroups(db, workspaceId, window, now),
    busiestWorkflows(db, workspaceId, provider, window),
    loadPriceBook(db, now),
  ]);
  const groups = all.filter((group) => group.provider === provider);
  return {
    provider,
    days: windowDays(window),
    pricesChecked: PRICES_CHECKED,
    ...totalOf(groups),
    runners: runnersOf(groups),
    workflows,
    prices: ratePrices(book, provider),
  };
}

/**
 * Each provider's billed minutes in buckets of `bucketMs` from `origin`, and in total over the
 * prior window when job_timing still reaches it. One range of job_timing_installation_idx from the
 * prior window's start (or the window's), grouped by bucket and the columns environmentFor reads.
 */
async function providerMinutes(
  db: Db,
  workspaceId: string,
  window: ReportWindow,
  { bucketMs, origin }: { bucketMs: number; origin: number },
  now: number,
) {
  const trend = hasTrend(window, now);
  const since = trend ? window.prior.from : window.from;
  // Jobs in the prior window are bucket -1, and any between it and the window (the rest of last
  // month, for this month so far) -2.
  const rows = await db.all<{
    bucket: number;
    labels: string;
    runner_group_name: string | null;
    minutes: number;
  }>(sql`
    select case when ${table.completedAt} < ${window.prior.to} then -1
        when ${table.completedAt} < ${window.from} then -2
        else cast((${table.completedAt} - ${origin}) / ${bucketMs} as integer) end as bucket,
      ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      sum(${BILLED_MINUTES}) as minutes
    from ${table}
    where ${where(workspaceId, { from: since, to: window.to })}
    group by 1, 2, 3`);
  const count = Math.max(1, Math.ceil((window.to - origin) / bucketMs));
  const buckets: ShareBucket[] = Array.from({ length: count }, (_, i) => ({
    start: origin + i * bucketMs,
    minutes: {},
  }));
  const prior = new Map<string, number>();
  const providers = new Map<string, string>();
  for (const row of rows) {
    const pair = `${row.labels}\u001f${row.runner_group_name}`;
    let provider = providers.get(pair);
    if (provider === undefined) {
      const env = environmentFor(JSON.parse(row.labels) as string[], row.runner_group_name, null);
      provider = providerOfEnvironment(env.key, isCatalogProvider);
      providers.set(pair, provider);
    }
    if (provider === "machine") continue;
    const minutes = Number(row.minutes);
    const at = Number(row.bucket);
    if (at < 0) {
      if (at === -1) prior.set(provider, (prior.get(provider) ?? 0) + minutes);
      continue;
    }
    const bucket = buckets[Math.min(count - 1, at)].minutes;
    bucket[provider] = (bucket[provider] ?? 0) + minutes;
  }
  return { buckets, prior: trend ? prior : null };
}

/**
 * Every provider the workspace's jobs ran on in the window, busiest first, with each one's billed
 * minutes a day at a time from `origin` (the window's start, or the reader's midnight before it),
 * or a week at a time past a month.
 */
export async function providersOverview(
  db: Db,
  workspaceId: string,
  window: ReportWindow,
  origin = window.from,
  now = Date.now(),
): Promise<ProvidersOverview> {
  const bucketMs = windowDays(window) > 31 ? 7 * DAY_MS : DAY_MS;
  const [groups, minutes] = await Promise.all([
    runnerGroups(db, workspaceId, window, now),
    providerMinutes(db, workspaceId, window, { bucketMs, origin }, now),
  ]);
  const byProvider = Map.groupBy(groups, (group) => group.provider);
  const providers = [...byProvider].map(([provider, groups]) => ({
    provider,
    ...totalOf(groups),
    runners: runnersOf(groups),
    priorBilledMinutes: minutes.prior && (minutes.prior.get(provider) ?? 0),
  }));
  providers.sort((a, b) => b.jobs - a.jobs);
  return {
    days: windowDays(window),
    pricesChecked: PRICES_CHECKED,
    providers,
    bucketMs,
    buckets: minutes.buckets,
  };
}
