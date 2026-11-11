// One provider's page: what this workspace's jobs did on it over the last few days, in total and
// per runner type. Read from job_timing like Job times (src/job-times.ts), with the same rules for
// which environment and provider a job belongs to, so the numbers match that page and Runners.
//
// Database cost: one statement, a range of job_timing_installation_idx (the workspace's
// installations, completed in the window), grouped by the columns environmentFor reads. The
// provider is worked out from each group's labels afterwards, since it's derived and not stored.
import { type ProviderId, providerOfEnvironment } from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { DAY_MS } from "./job-timings.ts";
import {
  DEFAULT_DAYS,
  type Environment,
  environmentFor,
  inWorkspace,
  parseSamples,
  RAN,
  SAMPLES,
  type Stat,
  statOf,
  OK,
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
  machine_id: string | null;
  runs: number;
  successes: number;
  failures: number;
  run_ms: number;
  samples: string | null;
}

const FAILED = sql`coalesce(${table.conclusion} in ('failure', 'timed_out'), 0)`;

/** The workspace's jobs on one provider over the last `days` days. */
export async function providerReport(
  db: Db,
  workspaceId: string,
  provider: ProviderId,
  days = DEFAULT_DAYS,
  now = Date.now(),
): Promise<ProviderReport> {
  const since = now - days * DAY_MS;
  const rows = await db.all<Row>(sql`
    select ${table.labels} as labels, ${table.runnerGroupName} as runner_group_name,
      ${table.machineId} as machine_id, count(*) as runs, sum(${OK}) as successes,
      sum(${FAILED}) as failures, sum(max(0, ${table.completedAt} - ${table.startedAt})) as run_ms,
      ${SAMPLES} as samples
    from ${table}
    where ${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since} and ${RAN}
    group by ${table.labels}, ${table.runnerGroupName}, ${table.machineId}`);

  // Several label sets can land on one runner type (`ubuntu-latest` and `ubuntu-24.04`).
  const runners = new Map<
    string,
    { env: Environment; counts: ProviderCounts; successes: number; samples: string[] }
  >();
  for (const row of rows) {
    const env = environmentFor(
      JSON.parse(row.labels) as string[],
      row.runner_group_name,
      row.machine_id,
    );
    if (providerOfEnvironment(env.key) !== provider) continue;
    const runner = runners.get(env.key) ?? {
      env,
      counts: { jobs: 0, failures: 0, runSeconds: 0 },
      successes: 0,
      samples: [],
    };
    runner.counts.jobs += Number(row.runs);
    runner.counts.failures += Number(row.failures);
    runner.counts.runSeconds += Number(row.run_ms) / 1000;
    runner.successes += Number(row.successes);
    if (row.samples) runner.samples.push(row.samples);
    runners.set(env.key, runner);
  }

  const totals: ProviderCounts = { jobs: 0, failures: 0, runSeconds: 0 };
  let successes = 0;
  const samples: string[] = [];
  const list: ProviderRunner[] = [];
  for (const { env, counts, successes: ok, samples: own } of runners.values()) {
    totals.jobs += counts.jobs;
    totals.failures += counts.failures;
    totals.runSeconds += counts.runSeconds;
    successes += ok;
    samples.push(...own);
    const stat = statOf({ runs: counts.jobs, successes: ok, samples: parseSamples(own.join(",")) });
    list.push({ ...env, ...counts, runSeconds: Math.round(counts.runSeconds), stat });
  }
  list.sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));

  return {
    provider,
    days,
    ...totals,
    runSeconds: Math.round(totals.runSeconds),
    stat: statOf({ runs: totals.jobs, successes, samples: parseSamples(samples.join(",")) }),
    runners: list,
  };
}
