// A provider page's charts over time: for each of its busiest runner types, a bar at a time (a day,
// or a week past a month), how long jobs waited for a runner and ran at P50 to P99, and how many
// the runner gave up on before a step ran.
//
// Database cost: one statement, a range of job_timing_installation_idx like the rest of the page,
// grouped by bar and the columns environmentFor reads, with each group's waits and run times
// concatenated so the percentiles are exact.
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { type Environment, environmentFor, OK, quantile } from "./job-times.ts";
import { RUNNER_FAILED, WAIT_MS } from "./job-timings.ts";
import { labelProviders, where } from "./provider-report.ts";
import { type Buckets, bucketStarts, type Window } from "./report-window.ts";

const table = schema.jobTiming;

/** Lines past this many runner types would be a tangle; the rest are left out. */
export const TREND_RUNNERS = 6;
/** Fewer values than this in a bar give no percentiles, so one slow job isn't a spike. */
export const MIN_VALUES = 3;

export const PERCENTILES = [50, 75, 90, 95, 99] as const;
export type Percentile = (typeof PERCENTILES)[number];
/** Milliseconds at each percentile, or null when the bar had fewer than MIN_VALUES. */
export type Percentiles = Record<`p${Percentile}`, number> | null;

export interface TrendPoint {
  /** Epoch ms. */
  start: number;
  jobs: number;
  /** Failed jobs the runner gave up on before any step ran. */
  runnerFailures: number;
  /** From queued to started, for every job with both. */
  wait: Percentiles;
  /** From started to completed, for successful jobs, like the rest of the page's times. */
  run: Percentiles;
}

export interface TrendRunner extends Environment {
  jobs: number;
  points: TrendPoint[];
}

export interface ProviderTrends {
  bucketMs: number;
  /** The busiest TREND_RUNNERS runner types, busiest first. */
  runners: TrendRunner[];
}

interface Row {
  bucket: number;
  labels: string;
  runner_group_name: string | null;
  jobs: number;
  runner_failures: number;
  waits: string | null;
  runs: string | null;
}

const numbers = (list: string | null) => (list ? list.split(",").map(Number) : []);

export function percentilesOf(values: number[]): Percentiles {
  if (values.length < MIN_VALUES) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return Object.fromEntries(
    PERCENTILES.map((p) => [`p${p}`, quantile(sorted, p / 100)!]),
  ) as Percentiles;
}

/** `provider`'s runner types over `window`, a point each of `buckets`. */
export async function providerTrends(
  db: Db,
  workspaceId: string,
  provider: string,
  window: Window,
  buckets: Buckets,
): Promise<ProviderTrends> {
  const { bucketMs, origin } = buckets;
  const rows = await db.all<Row>(sql`
    select cast((${table.completedAt} - ${origin}) / ${bucketMs} as integer) as bucket,
      ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name, count(*) as jobs,
      sum(coalesce(${RUNNER_FAILED}, 0)) as runner_failures,
      group_concat(${WAIT_MS}) as waits,
      group_concat(case when ${OK} then ${table.completedAt} - ${table.startedAt} end) as runs
    from ${table}
    where ${where(workspaceId, window)}
    group by 1, 2, 3`);

  const starts = bucketStarts(window, buckets);
  const providerOf = labelProviders();
  const groups = new Map<
    string,
    {
      env: Environment;
      jobs: number;
      bars: { jobs: number; failed: number; waits: number[]; runs: number[] }[];
    }
  >();
  for (const row of rows) {
    if (providerOf(row.labels, row.runner_group_name) !== provider) continue;
    const env = environmentFor(JSON.parse(row.labels) as string[], row.runner_group_name, null);
    const group = groups.get(env.key) ?? {
      env,
      jobs: 0,
      bars: starts.map(() => ({ jobs: 0, failed: 0, waits: [], runs: [] })),
    };
    const bar = group.bars[Math.min(starts.length - 1, Math.max(0, Number(row.bucket)))]!;
    const jobs = Number(row.jobs);
    group.jobs += jobs;
    bar.jobs += jobs;
    bar.failed += Number(row.runner_failures);
    bar.waits.push(...numbers(row.waits));
    bar.runs.push(...numbers(row.runs));
    groups.set(env.key, group);
  }

  const runners = [...groups.values()]
    .sort((a, b) => b.jobs - a.jobs || a.env.label.localeCompare(b.env.label))
    .slice(0, TREND_RUNNERS)
    .map(({ env, jobs, bars }) => ({
      ...env,
      jobs,
      points: bars.map((bar, i) => ({
        start: starts[i]!,
        jobs: bar.jobs,
        runnerFailures: bar.failed,
        wait: percentilesOf(bar.waits),
        run: percentilesOf(bar.runs),
      })),
    }));
  return { bucketMs, runners };
}
