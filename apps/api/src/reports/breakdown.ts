/**
 * Where CI time went, cut one way: the workspace's jobs in a window summed by repository, workflow,
 * job, person, branch, trigger, coding agent, provider, runner or job type, optionally a day at a
 * time, narrowed by the run filters. For agents (the MCP server's get_breakdown), so one general
 * question ("which workflow runs most per day?", "what did agent branches cost?") needs one call.
 *
 * Counts the jobs a runner ran, picks left out, like job times. Cost is estimated at GitHub's rates
 * after rounding each job up to a minute, as Usage's minutes per pull request does: self-hosted
 * runners and machines cost nothing, and a label GitHub doesn't price counts at its smallest Linux
 * rate. Runs count workflow runs (a re-run counts once) and only for the cuts a whole run falls in.
 *
 * Database cost: one or two statements over a range of job_timing_installation_idx, each job joined
 * to its run by workflow_run's primary key, grouped by the cut's columns, what prices a job, and the
 * day. Reads job_timing's own rows, so the route keeps the window within RAW_RETENTION_DAYS.
 */
import {
  BREAKDOWN_MAX_ROWS,
  type BreakdownBy,
  type BreakdownSort,
  runAgent,
  type RunFilters,
} from "@relayrunner/api-types";
import { type SQL, sql } from "drizzle-orm";
import { jobTypeKey, readJobTypes } from "../ai/job-type.ts";
import { aiAccess } from "../ai/settings.ts";
import { type Db, schema } from "../db/index.ts";
import { loadPriceBook } from "../providers/prices.ts";
import { DAY_MS } from "../time.ts";
import { environmentFor, environmentProvider, nameMachines } from "./environments.ts";
import type { Environment } from "./job-times.ts";
import {
  BILLED_MINUTES,
  DURATION_MS,
  FAILED,
  inWorkspace,
  matrixName,
  RAN,
  RUNNER_FAILED,
  WAIT_MS,
} from "./job-sql.ts";
import type { Window } from "./report-window.ts";
import { cents, pricePeriods, rateFor, runnerClass } from "./runner-rates.ts";
import { jobFilterSql, PERSON } from "./run-filters.ts";

const job = schema.jobTiming;
const run = schema.workflowRun;
const repo = schema.githubRepository;

/** The columns each cut groups by, besides what prices a job. */
const COLUMNS: Record<BreakdownBy, SQL[]> = {
  repository: [sql`${job.repositoryFullName}`],
  workflow: [sql`${job.repositoryFullName}`, sql`${job.workflowName}`],
  job: [sql`${job.repositoryFullName}`, sql`${job.workflowName}`, sql`${job.name}`],
  person: [PERSON],
  branch: [sql`${run.headBranch}`],
  trigger: [sql`${run.event}`],
  agent: [sql`${run.agent}`, sql`${run.headBranch}`],
  provider: [],
  runner: [],
  job_type: [sql`${job.repositoryId}`, sql`${job.workflowName}`, sql`${job.name}`],
};

/** The cuts a whole run falls in, so its runs add up across rows. */
const RUN_LEVEL = new Set<BreakdownBy>([
  "repository",
  "workflow",
  "person",
  "branch",
  "trigger",
  "agent",
]);

export interface BreakdownCounts {
  /** Workflow runs, a re-run counting once; null for cuts that split a run. */
  runs: number | null;
  jobs: number;
  /** Time jobs ran, start to finish. */
  minutes: number;
  /** Minutes after rounding each job up to a whole minute. */
  billedMinutes: number;
  /** Estimated USD at GitHub's rates; 0 on self-hosted runners and machines. */
  cost: number;
  /** Jobs that failed or timed out. */
  failures: number;
  /** Of those, jobs the runner gave up on before any step ran. */
  runnerFailures: number;
  /** Average wait for a runner, queued to started, or null when no job knows it. */
  waitSeconds: number | null;
}

export interface BreakdownRow extends BreakdownCounts {
  /** What the row is: a repo, a workflow's or job's name, a login, a provider id, ... */
  key: string;
  /** For workflow and job rows. */
  repository?: string;
  workflow?: string | null;
  /** A runner's name and kind, for runner rows. */
  label?: string;
  detail?: string;
  /** With `perDay`: minutes, jobs and runs on each of `days`, oldest first. */
  perDay?: { minutes: number[]; jobs: number[]; runs?: number[] };
}

export interface Breakdown {
  by: BreakdownBy;
  from: number;
  to: number;
  /** With `perDay`: each day, as YYYY-MM-DD in the reader's time zone. */
  days?: string[];
  /** Every job in the window, whatever the cut. */
  total: BreakdownCounts;
  /** The top `limit` rows by `sort`. */
  rows: BreakdownRow[];
  /** The rows past `limit`, added up, or null when none were left out. */
  rest: (BreakdownCounts & { rows: number }) | null;
  /** For job_type: whether AI may classify the workspace's jobs. Without it every job is "unknown". */
  ai?: boolean;
}

export interface BreakdownOptions {
  by: BreakdownBy;
  filters?: RunFilters;
  perDay?: boolean;
  /** Minutes east of UTC, so days end at the reader's midnight. */
  utcOffset?: number;
  sort?: BreakdownSort;
  limit?: number;
  now?: number;
}

type Sums = Omit<BreakdownCounts, "waitSeconds" | "runs"> & {
  runs: number;
  waitMs: number;
  waits: number;
};

const emptySums = (): Sums => ({
  runs: 0,
  jobs: 0,
  minutes: 0,
  billedMinutes: 0,
  cost: 0,
  failures: 0,
  runnerFailures: 0,
  waitMs: 0,
  waits: 0,
});

function addSums(into: Sums, from: Sums) {
  for (const key of Object.keys(into) as (keyof Sums)[]) into[key] += from[key];
}

const tenths = (value: number) => Math.round(value * 10) / 10;

function counts(sums: Sums, runLevel: boolean): BreakdownCounts {
  return {
    runs: runLevel ? sums.runs : null,
    jobs: sums.jobs,
    minutes: tenths(sums.minutes),
    billedMinutes: sums.billedMinutes,
    cost: cents(sums.cost),
    failures: sums.failures,
    runnerFailures: sums.runnerFailures,
    waitSeconds: sums.waits ? Math.round(sums.waitMs / sums.waits / 1000) : null,
  };
}

type Row = Record<`d${number}`, string | number | null> & {
  day: number;
  period: number;
  labels: string;
  runner_group_name: string | null;
  machine_id: string | null;
  private: number | null;
  jobs: number;
  run_ms: number;
  billed: number;
  failures: number;
  runner_failures: number;
  wait_ms: number | null;
  waits: number;
};

type RunRow = Record<`d${number}`, string | number | null> & { day: number; runs: number };

const dims = (row: Record<string, unknown>, n: number) =>
  Array.from({ length: n }, (_, i) => row[`d${i}`] as string | number | null);

export async function breakdown(
  db: Db,
  workspaceId: string,
  { from, to }: Window,
  {
    by,
    filters = {},
    perDay = false,
    utcOffset = 0,
    sort = "minutes",
    limit = 20,
    now = Date.now(),
  }: BreakdownOptions,
): Promise<Breakdown> {
  const book = await loadPriceBook(db, now);
  const prices = pricePeriods(book, job.completedAt, from, to);
  const offsetMs = utcOffset * 60_000;
  const firstDay = Math.floor((from + offsetMs) / DAY_MS);
  const dayCount = Math.max(1, Math.floor((to - 1 + offsetMs) / DAY_MS) - firstDay + 1);
  // Cast, since D1 may bind the numbers as reals.
  const day = perDay
    ? sql`cast((${job.completedAt} + ${offsetMs}) / ${DAY_MS} as integer)`
    : sql`0`;
  const columns = COLUMNS[by];
  const selected = columns.map((column, i) => sql`${column} as ${sql.raw(`d${i}`)}`);
  const where = sql`${inWorkspace(workspaceId)}
    and ${job.completedAt} >= ${from} and ${job.completedAt} < ${to}
    and ${RAN} and ${jobFilterSql(filters)}`;
  const from_ = sql`${job}
    left join ${run} on ${run.id} = ${job.runId} and ${run.runAttempt} = ${job.runAttempt}`;
  const groupBy = (extra: SQL[]) => sql.join([...columns, sql`day`, ...extra], sql`, `);
  const lead = (parts: SQL[]) => (parts.length ? sql`${sql.join(parts, sql`, `)}, ` : sql``);
  const runLevel = RUN_LEVEL.has(by);

  const [rows, runRows, types, access] = await Promise.all([
    db.all<Row>(sql`
      select ${lead(selected)}${day} as day, ${prices.period} as period,
        ${job.labels} as labels, ${job.runnerGroupName} as runner_group_name,
        ${job.machineId} as machine_id, ${repo.private} as private,
        count(*) as jobs, sum(${DURATION_MS}) as run_ms, sum(${BILLED_MINUTES}) as billed,
        sum(${FAILED}) as failures, sum(${RUNNER_FAILED}) as runner_failures,
        sum(${WAIT_MS}) as wait_ms, count(${WAIT_MS}) as waits
      from ${from_} left join ${repo} on ${repo.id} = ${job.repositoryId}
      where ${where}
      group by ${groupBy([...prices.groupBy, sql`${job.labels}`, sql`${job.runnerGroupName}`, sql`${job.machineId}`, sql`${repo.private}`])}`),
    // Runs don't add up across what prices a job (one run's jobs can run on several runners), so
    // they're counted on their own, and only for the cuts a whole run falls in.
    runLevel
      ? db.all<RunRow>(sql`
          select ${lead(selected)}${day} as day, count(distinct ${job.runId}) as runs
          from ${from_} where ${where} group by ${groupBy([])}`)
      : Promise.resolve([] as RunRow[]),
    by === "job_type" ? readJobTypes(db, workspaceId) : Promise.resolve(null),
    by === "job_type" ? aiAccess(db, workspaceId, "job_type", now) : Promise.resolve(null),
  ]);

  // The row each group adds to, by its cut's columns.
  const envs = new Map<string, Environment>();
  const keyOf = (
    values: (string | number | null)[],
    row?: Row,
  ): Omit<BreakdownRow, keyof BreakdownCounts> => {
    switch (by) {
      case "repository":
        return { key: String(values[0]) };
      case "workflow":
        return {
          key: `${values[0]}\0${values[1] ?? ""}`,
          repository: String(values[0]),
          workflow: values[1] as string | null,
        };
      case "job": {
        const name = String(values[2]);
        return {
          key: `${values[0]}\0${values[1] ?? ""}\0${matrixName(name) ?? name}`,
          repository: String(values[0]),
          workflow: values[1] as string | null,
        };
      }
      case "agent":
        return {
          key: runAgent(values[0] as string | null, values[1] as string | null)?.id ?? "none",
        };
      case "job_type":
        return {
          key:
            types?.get(
              jobTypeKey(Number(values[0]), values[1] as string | null, String(values[2])),
            ) ?? "unknown",
        };
      case "provider":
      case "runner": {
        const env = environmentFor(
          JSON.parse(row!.labels),
          row!.runner_group_name,
          row!.machine_id,
        );
        if (by === "provider") return { key: environmentProvider(env) };
        envs.set(env.key, envs.get(env.key) ?? env);
        return { key: env.key };
      }
      default:
        return { key: values[0] === null ? "(none)" : String(values[0]) };
    }
  };

  type Group = { meta: Omit<BreakdownRow, keyof BreakdownCounts>; sums: Sums; days: Sums[] | null };
  const groups = new Map<string, Group>();
  const total = emptySums();
  const groupFor = (meta: Group["meta"]) => {
    let group = groups.get(meta.key);
    if (!group) {
      group = {
        meta,
        sums: emptySums(),
        days: perDay ? Array.from({ length: dayCount }, emptySums) : null,
      };
      groups.set(meta.key, group);
    }
    return group;
  };
  const dayOf = (group: Group, value: number) => group.days?.[Number(value) - firstDay];

  for (const row of rows) {
    const labels = JSON.parse(row.labels) as string[];
    const sums: Sums = {
      ...emptySums(),
      jobs: Number(row.jobs),
      minutes: Math.max(0, Number(row.run_ms)) / 60_000,
      billedMinutes: Number(row.billed),
      cost:
        Number(row.billed) *
        rateFor(
          book,
          runnerClass(labels, row.runner_group_name),
          row.private === null ? null : Boolean(row.private),
          prices.at(Number(row.period)),
        ),
      failures: Number(row.failures),
      runnerFailures: Number(row.runner_failures),
      waitMs: Math.max(0, Number(row.wait_ms ?? 0)),
      waits: Number(row.waits),
    };
    const group = groupFor(keyOf(dims(row, columns.length), row));
    addSums(group.sums, sums);
    addSums(total, sums);
    const bucket = dayOf(group, row.day);
    if (bucket) addSums(bucket, sums);
  }
  for (const row of runRows) {
    const group = groupFor(keyOf(dims(row, columns.length)));
    const runs = Number(row.runs);
    group.sums.runs += runs;
    total.runs += runs;
    const bucket = dayOf(group, row.day);
    if (bucket) bucket.runs += runs;
  }

  await nameMachines(db, workspaceId, envs);
  const sorted = [...groups.values()].sort(
    (a, b) =>
      (b.sums[sort] as number) - (a.sums[sort] as number) || b.sums.minutes - a.sums.minutes,
  );
  const shown = sorted.slice(0, Math.min(limit, BREAKDOWN_MAX_ROWS));
  const left = sorted.slice(shown.length);
  const rest = emptySums();
  for (const group of left) addSums(rest, group.sums);

  return {
    by,
    from,
    to,
    ...(perDay && {
      days: Array.from({ length: dayCount }, (_, i) =>
        new Date((firstDay + i) * DAY_MS).toISOString().slice(0, 10),
      ),
    }),
    total: counts(total, runLevel),
    rows: shown.map(({ meta, sums, days }) => {
      const env = by === "runner" ? envs.get(meta.key) : undefined;
      return {
        ...meta,
        key:
          by === "workflow"
            ? (meta.workflow ?? "(unnamed)")
            : by === "job"
              ? meta.key.split("\0")[2]!
              : meta.key,
        ...(env && { label: env.label, detail: env.detail }),
        ...counts(sums, runLevel),
        ...(days && {
          perDay: {
            minutes: days.map((d) => tenths(d.minutes)),
            jobs: days.map((d) => d.jobs),
            ...(runLevel && { runs: days.map((d) => d.runs) }),
          },
        }),
      };
    }),
    rest: left.length ? { ...counts(rest, runLevel), rows: left.length } : null,
    ...(by === "job_type" && { ai: access !== null }),
  };
}
