// One runner's detail panel: how busy it was each day over the window, its times, the jobs it ran
// last and, for a connected machine, when it was online. Read from job_timing like Performance
// (src/job-times.ts), with the same environments and sample buckets, so its numbers match that page.
//
// Database cost: a machine reads its own range of the partial job_timing_machine_idx. Any other
// runner reads the workspace's window from job_timing_installation_idx grouped by the columns
// environmentFor reads, like the Performance summary, since the environment is derived and not
// stored; its recent jobs are a second, newest-first read of that range that stops at RECENT_LIMIT.
// A machine's connections are a range of activity_event_type_idx.
import { and, asc, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import {
  bucketOf,
  emptyBucket,
  type Environment,
  environmentFor,
  type JobRun,
  machineWindowWhere,
  mergeInto,
  missedQuery,
  nameMachines,
  OK,
  SAMPLES,
  type Stat,
  statOf,
  windowWhere,
} from "./job-times.ts";
import { DAY_MS } from "./job-timings.ts";
import { inWorkspace as machineInWorkspace } from "./machines.ts";

const table = schema.jobTiming;
const MACHINE = "machine:";

/** Most recent jobs the panel lists. */
export const RECENT_LIMIT = 25;

export interface RunnerDay {
  /** Epoch ms of the day's local midnight, in the reader's UTC offset. */
  day: number;
  jobs: number;
  /** Jobs that failed or timed out. Cancelled jobs count in neither. */
  failures: number;
  /** Time spent running jobs, summed. */
  busyMs: number;
}

/** A job the runner ran, with what it belongs to, for its row in the panel. */
export interface RunnerJob extends JobRun {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  name: string;
}

export interface RunnerReport {
  days: number;
  environment: Environment;
  stat: Stat;
  /** Jobs sent here that no runner picked up (see missedQuery). */
  missed: number;
  busyMs: number;
  /** Days with jobs, oldest first. Days without any are left out. */
  daily: RunnerDay[];
  /** Newest first, at most RECENT_LIMIT. */
  recent: RunnerJob[];
  /**
   * A connected machine's connections and disconnections in the window, oldest first. Null for any
   * other runner, whose online history RelayRunner doesn't see.
   */
  connections: { at: number; online: boolean }[] | null;
}

const FAILED = sql`coalesce(${table.conclusion} in ('failure', 'timed_out'), 0)`;

interface DayRow {
  labels: string;
  runner_group_name: string | null;
  day: number;
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
 * One runner's report over the last `days` days, by its Performance environment key. Days are cut
 * at local midnight for `utcOffset` (minutes east of UTC).
 */
export async function runnerReport(
  db: Db,
  workspaceId: string,
  key: string,
  { days, utcOffset = 0, now = Date.now() }: { days: number; utcOffset?: number; now?: number },
): Promise<RunnerReport> {
  const since = new Date(now - days * DAY_MS);
  const offsetMs = utcOffset * 60_000;
  const machineId = key.startsWith(MACHINE) ? key.slice(MACHINE.length) : null;
  // Only a machine in this workspace: another's id reads nothing.
  const scope = machineId
    ? machineWindowWhere(
        workspaceId,
        sql`select ${schema.machine.id} from ${schema.machine}
          where ${machineInWorkspace(db, workspaceId)} and ${schema.machine.id} = ${machineId}`,
        since,
      )
    : sql`${windowWhere(workspaceId, since)} and ${table.machineId} is null`;
  // Cast, since D1 may bind the numbers as reals.
  const day = sql`cast((${table.completedAt} + ${offsetMs}) / ${DAY_MS} as integer)`;
  const groupBy = machineId ? sql`${day}` : sql`${table.labels}, ${table.runnerGroupName}, ${day}`;

  const [rows, missedRows, connections] = await Promise.all([
    db.all<DayRow>(sql`
      select min(${table.labels}) as labels, min(${table.runnerGroupName}) as runner_group_name,
        ${day} as day, count(*) as runs, sum(${OK}) as successes, sum(${FAILED}) as failures,
        sum(${table.completedAt} - ${table.startedAt}) as busy_ms, ${SAMPLES} as samples
      from ${table} where ${scope}
      group by ${groupBy}`),
    db.all<{
      labels: string;
      runner_group_name: string | null;
      machine_id: string | null;
      missed: number;
    }>(missedQuery(workspaceId, since)),
    machineId ? machineConnections(db, workspaceId, machineId, since) : null,
  ]);

  const envOf = (labels: string, group: string | null, machine: string | null) =>
    environmentFor(JSON.parse(labels) as string[], group, machine);
  let environment: Environment | null = machineId ? { key, label: "Machine", detail: "" } : null;
  const combos = new Set<string>();
  const bucket = emptyBucket();
  const daily = new Map<number, RunnerDay>();
  for (const row of rows) {
    if (!machineId) {
      const env = envOf(row.labels, row.runner_group_name, null);
      if (env.key !== key) continue;
      environment ??= env;
      combos.add(comboOf(row.labels, row.runner_group_name));
    }
    mergeInto(bucket, bucketOf(row));
    const start = Number(row.day) * DAY_MS - offsetMs;
    const into = daily.get(start) ?? { day: start, jobs: 0, failures: 0, busyMs: 0 };
    into.jobs += Number(row.runs);
    into.failures += Number(row.failures);
    into.busyMs += Number(row.busy_ms);
    daily.set(start, into);
  }

  let missed = 0;
  for (const row of missedRows) {
    const env = envOf(row.labels, row.runner_group_name, row.machine_id);
    if (env.key !== key) continue;
    environment ??= env;
    missed += Number(row.missed);
  }

  const recent =
    machineId || combos.size
      ? await recentJobs(
          db,
          machineId ? scope : sql`${scope} and ${COMBO} in (${sql.join([...combos], sql`, `)})`,
          key,
        )
      : [];

  environment ??= { key, label: key.slice(key.indexOf(":") + 1) || key, detail: "" };
  if (machineId) await nameMachines(db, workspaceId, new Map([[key, environment]]));
  const byDay = [...daily.values()].sort((a, b) => a.day - b.day);
  return {
    days,
    environment,
    stat: statOf(bucket),
    missed,
    busyMs: byDay.reduce((sum, each) => sum + each.busyMs, 0),
    daily: byDay,
    recent,
    connections,
  };
}

async function recentJobs(db: Db, where: SQL, key: string): Promise<RunnerJob[]> {
  const rows = await db
    .select({
      id: table.id,
      runId: table.runId,
      runAttempt: table.runAttempt,
      repositoryId: table.repositoryId,
      repository: table.repositoryFullName,
      workflow: table.workflowName,
      name: table.name,
      conclusion: table.conclusion,
      queuedAt: table.queuedAt,
      startedAt: table.startedAt,
      completedAt: table.completedAt,
    })
    .from(table)
    .where(where)
    .orderBy(sql`${table.completedAt} desc`)
    .limit(RECENT_LIMIT);
  return rows.flatMap((row) =>
    row.startedAt && row.completedAt
      ? [
          {
            ...row,
            environment: key,
            queuedAt: row.queuedAt?.getTime() ?? null,
            startedAt: row.startedAt.getTime(),
            completedAt: row.completedAt.getTime(),
          },
        ]
      : [],
  );
}

const events = schema.activityEvent;

// A connected machine's connections in the window. A runner added from GitHub has none: GitHub
// keeps its connection, so it's null there.
async function machineConnections(db: Db, workspaceId: string, machineId: string, since: Date) {
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
        eq(events.machineId, machineId),
      ),
    )
    .orderBy(asc(events.occurredAt), asc(events.id));
  return rows.map((row) => ({ at: row.at.getTime(), online: row.type === "machine.connected" }));
}
