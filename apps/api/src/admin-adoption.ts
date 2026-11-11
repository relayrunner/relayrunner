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

/** Per workspace id: its jobs over the window ending at `now`, and its latest job. */
export async function workspaceJobs(db: Db, now = new Date()): Promise<Map<string, WorkspaceJobs>> {
  const since = now.getTime() - ADOPTION_WINDOW_MS;
  const job = schema.jobTiming;
  const recent = sql`${job.completedAt} >= ${since}`;
  const rows = await db
    .select({
      workspaceId: schema.workspace.id,
      jobs: sql<number>`coalesce(sum(${recent}), 0)`,
      machineJobs: sql<number>`coalesce(sum(${recent} and ${job.machineId} is not null), 0)`,
      lastJobAt: sql<number | null>`max(${job.completedAt})`,
    })
    .from(job)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, job.installationId))
    .where(and(isNotNull(job.completedAt), RAN_ON_RUNNER, sql`not ${PICK}`))
    .groupBy(schema.workspace.id);
  return new Map(
    rows.map((row) => [
      row.workspaceId,
      { jobs7d: row.jobs, machineJobs7d: row.machineJobs, lastJobAt: iso(row.lastJobAt) },
    ]),
  );
}
