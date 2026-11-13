/**
 * How far each workspace got with RelayRunner, for Admin › Workspaces: when each setup step first
 * happened and its jobs over the past week. Reads tables we already keep, so there is no migration.
 * The first job on a machine comes from route_decision, which is never purged; job counts come from
 * job_timing, whose rows are kept 31 days, so a workspace quiet for longer shows no last job.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { PICK, RAN_ON_RUNNER } from "./job-times.ts";

export const ADOPTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The setup steps in order. Each is when it first happened, or null when it hasn't yet. */
export type SetupSteps = {
  signedUpAt: string | null;
  installedAt: string | null;
  machineAt: string | null;
  firstMachineJobAt: string | null;
};

export type WorkspaceJobs = {
  /** Jobs a runner ran in the past 7 days, picks left out like on the Usage page. */
  jobs7d: number;
  /** How many of those ran on a machine. */
  machineJobs7d: number;
  lastJobAt: string | null;
};

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

/** Per workspace id: when a machine first joined it, and when a run was first routed to one. */
export async function machineMilestones(db: Db) {
  const [machines, machineJobs] = await Promise.all([
    db
      .select({
        workspaceId: schema.activityEvent.workspaceId,
        at: sql<number>`min(${schema.activityEvent.occurredAt})`,
      })
      .from(schema.activityEvent)
      .where(inArray(schema.activityEvent.type, ["machine.enrolled", "machine.connected"]))
      .groupBy(schema.activityEvent.workspaceId),
    db
      .select({
        workspaceId: schema.routeDecision.workspaceId,
        at: sql<number>`min(${schema.routeDecision.createdAt})`,
      })
      .from(schema.routeDecision)
      .where(eq(schema.routeDecision.step, "machine"))
      .groupBy(schema.routeDecision.workspaceId),
  ]);
  return {
    machineAt: new Map(machines.map((row) => [row.workspaceId, iso(row.at)])),
    firstMachineJobAt: new Map(machineJobs.map((row) => [row.workspaceId, iso(row.at)])),
  };
}

/**
 * Per workspace id: its jobs over the window ending at `now`, and its latest job. The window is a
 * range of job_timing_completed_idx; each latest job walks job_timing_installation_idx back from
 * the newest row, so neither reads the whole table.
 */
export async function workspaceJobs(db: Db, now = new Date()): Promise<Map<string, WorkspaceJobs>> {
  const since = now.getTime() - ADOPTION_WINDOW_MS;
  const job = schema.jobTiming;
  const ran = and(RAN_ON_RUNNER, sql`not ${PICK}`);
  const [recent, latest] = await Promise.all([
    db
      .select({
        workspaceId: schema.workspace.id,
        jobs: sql<number>`count(*)`,
        machineJobs: sql<number>`sum(${job.machineId} is not null)`,
      })
      .from(job)
      .innerJoin(schema.workspace, eq(schema.workspace.installationId, job.installationId))
      .where(and(sql`${job.completedAt} >= ${since}`, ran))
      .groupBy(schema.workspace.id),
    db
      .select({
        workspaceId: schema.workspace.id,
        // Spelled out: Drizzle leaves columns unqualified when there is no join, which would make
        // this match job_timing's own installation_id.
        at: sql<number | null>`(select ${job.completedAt} from ${job}
          where ${job.installationId} = "workspace"."installation_id"
            and ${isNotNull(job.completedAt)} and ${ran}
          order by ${job.completedAt} desc limit 1)`,
      })
      .from(schema.workspace),
  ]);
  const counts = new Map(recent.map((row) => [row.workspaceId, row]));
  return new Map(
    latest
      .filter((row) => row.at !== null)
      .map((row) => {
        const count = counts.get(row.workspaceId);
        return [
          row.workspaceId,
          {
            jobs7d: count?.jobs ?? 0,
            machineJobs7d: count?.machineJobs ?? 0,
            lastJobAt: iso(row.at),
          },
        ];
      }),
  );
}
