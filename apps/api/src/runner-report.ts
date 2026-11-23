// One runner's detail panel: how busy it was through the window (per quarter hour, hour or day),
// its times, the jobs it ran last and, for a connected machine, when it was online. Read from job_timing like Performance
// (src/job-times.ts), with the same environments and sample buckets, so its numbers match that page.
//
// Database cost: a machine reads its own range of the partial job_timing_machine_idx. Any other
// runner reads the workspace's window from job_timing_installation_idx grouped by the columns
// environmentFor reads, like the Performance summary, since the environment is derived and not
// stored; its recent jobs are a second, newest-first read of that range that stops at RECENT_LIMIT.
// A machine's connections are a range of activity_event_type_idx.
import { environmentFor, nameMachines } from "./environments.ts";
import { FAILED, NOT_PICKED_UP, OK, SAMPLES, windowWhere } from "./job-sql.ts";
import { and, asc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import {
  bucketOf,
  emptyBucket,
  type Environment,
  type HistoryJob,
  historyJobOf,
  jobListQuery,
  machineWindowWhere,
  mergeInto,
  missedQuery,
  type Stat,
  statOf,
} from "./job-times.ts";
import { inWorkspace as machineInWorkspace } from "./machines.ts";

const table = schema.jobTiming;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MACHINE = "machine:";

/** Most recent jobs the panel lists. */
const RECENT_LIMIT = 25;

/** The longest window the panel reads, as Performance does. */
export const MAX_RANGE_MS = 30 * DAY_MS;

/**
 * The panel's bars: a bar per 15 minutes up to 6 hours, per hour up to two days (with an hour to
 * spare, so "today" and "yesterday" stay hourly), then per day.
 */
export function bucketFor(spanMs: number) {
  if (spanMs <= 6 * HOUR_MS) return 15 * 60_000;
  if (spanMs <= 2 * DAY_MS + HOUR_MS) return HOUR_MS;
  return DAY_MS;
}

export interface RunnerBucket {
  /** Epoch ms the bar starts at; a day starts at the reader's local midnight. */
  start: number;
  jobs: number;
  /** Jobs that failed or timed out. Cancelled jobs count in neither. */
  failures: number;
  /** Time spent running jobs, summed. */
  busyMs: number;
}

/** A job the runner ran, with what it belongs to, for its row in the panel. */
export type RunnerJob = HistoryJob;

export interface RunnerReport {
  /** The window, in epoch ms. */
  from: number;
  to: number;
  /** How long each of `buckets` spans (see bucketFor). */
  bucketMs: number;
  environment: Environment;
  stat: Stat;
  /** Jobs sent here that no runner picked up (see missedQuery). */
  missed: number;
  /** Every bar in the window, oldest first, with zeros where there were no jobs. */
  buckets: RunnerBucket[];
  /** Newest first, at most RECENT_LIMIT. */
  recent: RunnerJob[];
  /**
   * A connected machine's connections and disconnections in the window, oldest first. Null for any
   * other runner, whose online history RelayRunner doesn't see.
   */
  connections: { at: number; online: boolean }[] | null;
}

interface BucketRow {
  labels: string;
  runner_group_name: string | null;
  bucket: number;
  runs: number;
  successes: number;
  failures: number;
  busy_ms: number;
  samples: string | null;
}

// The label set and runner group a job was sent with, as one string to match on in SQL.
const COMBO = sql`${table.labels} || char(31) || coalesce(${table.runnerGroupName}, '')`;
const comboOf = (labels: string, group: string | null) => `${labels}\u001f${group ?? ""}`;

/**
 * One runner's report from `from` to `to` (epoch ms, `to` defaulting to now), by its Performance
 * environment key. Bars are cut at local midnight and hours for `utcOffset` (minutes east of UTC).
 */
export async function runnerReport(
  db: Db,
  workspaceId: string,
  key: string,
  options: { from: number; to?: number; utcOffset?: number; now?: number },
): Promise<RunnerReport> {
  const { from, utcOffset = 0, now = Date.now() } = options;
  const to = Math.min(options.to ?? now, now);
  const since = new Date(from);
  const bucketMs = bucketFor(to - from);
  const offsetMs = utcOffset * 60_000;
  const machineId = key.startsWith(MACHINE) ? key.slice(MACHINE.length) : null;
  // Only a machine in this workspace: another's id reads nothing.
  const scope = machineId
    ? machineWindowWhere(
        workspaceId,
        sql`select ${schema.machine.id} from ${schema.machine}
          where ${machineInWorkspace(db, workspaceId)} and ${schema.machine.id} = ${machineId}`,
        since,
        to,
      )
    : sql`${windowWhere(workspaceId, since, to)} and ${table.machineId} is null`;
  // Cast, since D1 may bind the numbers as reals.
  const bucket = sql`cast((${table.completedAt} + ${offsetMs}) / ${bucketMs} as integer)`;
  const groupBy = machineId
    ? sql`${bucket}`
    : sql`${table.labels}, ${table.runnerGroupName}, ${bucket}`;

  // A machine's jobs are found by its id; any other runner's by the label sets that map to it,
  // known once the day rows are in.
  const [rows, missedRows, connections, machineRecent] = await Promise.all([
    db.all<BucketRow>(sql`
      select min(${table.labels}) as labels, min(${table.runnerGroupName}) as runner_group_name,
        ${bucket} as bucket, count(*) as runs, sum(${OK}) as successes, sum(${FAILED}) as failures,
        sum(${table.completedAt} - ${table.startedAt}) as busy_ms, ${SAMPLES} as samples
      from ${table} where ${scope}
      group by ${groupBy}`),
    machineId
      ? machineMissed(db, workspaceId, machineId, since, to)
      : db.all<MissedRow>(missedQuery(workspaceId, since, to)),
    machineId ? machineConnections(db, workspaceId, machineId, since, to) : null,
    machineId ? runnerJobs(db, scope, key) : null,
  ]);

  // Label sets repeat across days, so each is worked out once.
  const envs = new Map<string, Environment>();
  const envOf = (labels: string, group: string | null, machine: string | null) => {
    const combo = `${comboOf(labels, group)}\u001f${machine ?? ""}`;
    let env = envs.get(combo);
    if (!env) {
      env = environmentFor(JSON.parse(labels) as string[], group, machine);
      envs.set(combo, env);
    }
    return env;
  };
  let environment: Environment | null = machineId ? { key, label: "Machine", detail: "" } : null;
  const combos = new Set<string>();
  const stats = emptyBucket();
  // Every bar from the one `from` falls in, so the panel draws them as they come.
  const buckets = new Map<number, RunnerBucket>();
  const first = Math.floor((from + offsetMs) / bucketMs) * bucketMs - offsetMs;
  for (let start = first; start < to; start += bucketMs)
    buckets.set(start, { start, jobs: 0, failures: 0, busyMs: 0 });
  for (const row of rows) {
    if (!machineId) {
      const env = envOf(row.labels, row.runner_group_name, null);
      if (env.key !== key) continue;
      environment ??= env;
      combos.add(comboOf(row.labels, row.runner_group_name));
    }
    mergeInto(stats, bucketOf(row));
    const into = buckets.get(Number(row.bucket) * bucketMs - offsetMs);
    if (!into) continue;
    into.jobs += Number(row.runs);
    into.failures += Number(row.failures);
    into.busyMs += Number(row.busy_ms);
  }

  let missed = 0;
  for (const row of missedRows) {
    if (!machineId) {
      const env = envOf(row.labels, row.runner_group_name, row.machine_id);
      if (env.key !== key) continue;
      environment ??= env;
    }
    missed += Number(row.missed);
  }

  let recent = machineRecent ?? [];
  if (combos.size) {
    const sets = sql.join([...combos], sql`, `);
    recent = await runnerJobs(db, sql`${scope} and ${COMBO} in (${sets})`, key);
  }

  environment ??= { key, label: key.slice(key.indexOf(":") + 1) || key, detail: "" };
  if (machineId) await nameMachines(db, workspaceId, new Map([[key, environment]]));
  return {
    from,
    to,
    bucketMs,
    environment,
    stat: statOf(stats),
    missed,
    buckets: [...buckets.values()],
    recent,
    connections,
  };
}

interface MissedRow {
  labels: string;
  runner_group_name: string | null;
  machine_id: string | null;
  missed: number;
}

// A machine's missed jobs, from its own range of job_timing_machine_idx.
function machineMissed(db: Db, workspaceId: string, machineId: string, since: Date, to: number) {
  return db.all<MissedRow>(sql`
    select null as labels, null as runner_group_name, ${table.machineId} as machine_id,
      count(*) as missed
    from ${table}
    where ${table.machineId} = ${machineId}
      and ${table.installationId} = (
        select ${schema.workspace.installationId} from ${schema.workspace}
        where ${schema.workspace.id} = ${workspaceId})
      and ${table.completedAt} >= ${since.getTime()} and ${table.completedAt} < ${to}
      and ${NOT_PICKED_UP}`);
}

async function runnerJobs(db: Db, where: SQL, key: string): Promise<RunnerJob[]> {
  const rows = await jobListQuery(db, where, RECENT_LIMIT);
  return rows.flatMap((row) => {
    const job = historyJobOf(row, { key, label: "", detail: "" });
    return job ? [job] : [];
  });
}

const events = schema.activityEvent;

// A connected machine's connections in the window. A runner added from GitHub has none: GitHub
// keeps its connection, so it's null there.
async function machineConnections(
  db: Db,
  workspaceId: string,
  machineId: string,
  since: Date,
  to: number,
) {
  const [machine] = await db
    .select({ source: schema.machine.source })
    .from(schema.machine)
    .where(and(machineInWorkspace(db, workspaceId), eq(schema.machine.id, machineId)))
    .limit(1);
  if (!machine || machine.source === "github") return null;
  const rows = await db
    .select({ type: events.type, at: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, workspaceId),
        inArray(events.type, ["machine.connected", "machine.disconnected"]),
        gte(events.occurredAt, since),
        lt(events.occurredAt, new Date(to)),
        eq(events.machineId, machineId),
      ),
    )
    .orderBy(asc(events.occurredAt), asc(events.id));
  return rows.map((row) => ({ at: row.at.getTime(), online: row.type === "machine.connected" }));
}
