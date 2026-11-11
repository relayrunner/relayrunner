// One provider's page: what this workspace's jobs did on it over the last few days, in total and
// per runner type. Read from job_timing like Job times (src/job-times.ts), with the same rows,
// environments and sample buckets, so the numbers match that page and Runners.
//
// Database cost: one statement, a range of job_timing_installation_idx (the workspace's
// installations, completed in the window), grouped by the columns environmentFor reads. The
// provider is worked out from each group's labels afterwards, since it's derived and not stored.
import { type ProviderId, providerOfEnvironment } from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { DAY_MS } from "./job-timings.ts";
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

export interface ProviderCounts {
  /** Jobs a runner finished, whatever their result. */
  jobs: number;
  /** Jobs that failed or timed out. Cancelled jobs count in neither. */
  failures: number;
  /** Time the jobs ran, start to finish. */
  runSeconds: number;
}

export interface ProviderRunner extends Environment, ProviderCounts {
  stat: Stat;
}

export interface ProviderReport extends ProviderCounts {
  provider: ProviderId;
  days: number;
  /** Times across every runner type, from the newest successful runs. */
  stat: Stat;
  /** Busiest first. */
  runners: ProviderRunner[];
}

interface Row {
  labels: string;
  runner_group_name: string | null;
  runs: number;
  successes: number;
  failures: number;
  run_ms: number;
  samples: string | null;
}

const FAILED = sql`coalesce(${table.conclusion} in ('failure', 'timed_out'), 0)`;

const sum = (runners: ProviderRunner[], pick: (runner: ProviderRunner) => number) =>
  runners.reduce((total, runner) => total + pick(runner), 0);

/** The workspace's jobs on one provider over the last `days` days. */
export async function providerReport(
  db: Db,
  workspaceId: string,
  provider: ProviderId,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<ProviderReport> {
  // Machines are never a provider, so their jobs are left out in SQL.
  const rows = await db.all<Row>(sql`
    select ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      count(*) as runs, sum(${OK}) as successes, sum(${FAILED}) as failures,
      sum(max(0, ${table.completedAt} - ${table.startedAt})) as run_ms, ${SAMPLES} as samples
    from ${table}
    where ${windowWhere(workspaceId, new Date(now - days * DAY_MS))} and ${table.machineId} is null
    group by ${table.labels}, ${table.runnerGroupName}`);

  // Several label sets can land on one runner type (`ubuntu-latest` and `ubuntu-24.04`).
  const groups = new Map<
    string,
    { env: Environment; failures: number; runMs: number; bucket: Bucket }
  >();
  for (const row of rows) {
    const env = environmentFor(JSON.parse(row.labels) as string[], row.runner_group_name, null);
    if (providerOfEnvironment(env.key) !== provider) continue;
    const group = groups.get(env.key) ?? { env, failures: 0, runMs: 0, bucket: emptyBucket() };
    group.failures += Number(row.failures);
    group.runMs += Number(row.run_ms);
    mergeInto(group.bucket, bucketOf(row));
    groups.set(env.key, group);
  }

  const total = emptyBucket();
  const runners: ProviderRunner[] = [];
  for (const { env, failures, runMs, bucket } of groups.values()) {
    mergeInto(total, bucket);
    const runSeconds = Math.round(runMs / 1000);
    runners.push({ ...env, jobs: bucket.runs, failures, runSeconds, stat: statOf(bucket) });
  }
  runners.sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));

  return {
    provider,
    days,
    jobs: total.runs,
    failures: sum(runners, (r) => r.failures),
    runSeconds: sum(runners, (r) => r.runSeconds),
    stat: statOf(total),
    runners,
  };
}
