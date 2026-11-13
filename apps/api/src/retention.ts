// The hourly cleanup of the Activity page's tables, which grow with every run: workflow_job,
// activity_event and route_decision keep JOB_TIMING_RETENTION_DAYS, as far back as the Usage page
// reads (it sums free checks from activity_event). Each workspace's first machine event and first
// run routed to a machine stay, because Admin › Workspaces shows when those first happened.
import { inArray, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { DAY_MS, JOB_TIMING_RETENTION_DAYS, purgeBefore } from "./job-timings.ts";

const { activityEvent, routeDecision, workflowJob } = schema;

/** Drops Activity rows past retention. Returns how many rows went. */
export async function purgeOldActivity(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - JOB_TIMING_RETENTION_DAYS * DAY_MS);
  // A job's own events go with it (activity_event.job_id cascades). Naming both kinds lets
  // workflow_job_kind_created_idx answer the date range.
  const jobs = await purgeBefore(
    db,
    workflowJob,
    workflowJob.githubCreatedAt,
    cutoff,
    inArray(workflowJob.kind, ["pick", "job"]),
  );
  // activity_event ids grow with time, so the oldest event still kept bounds the rest by id.
  // Finding it reads only the rows about to go.
  const [firstKept] = await db
    .select({ id: activityEvent.id })
    .from(activityEvent)
    .where(sql`${activityEvent.occurredAt} >= ${cutoff.getTime()}`)
    .orderBy(activityEvent.id)
    .limit(1);
  const events = firstKept
    ? await purgeBefore(
        db,
        activityEvent,
        activityEvent.id,
        firstKept.id,
        sql`${activityEvent.id} not in (select min(${activityEvent.id}) from ${activityEvent}
          where ${inArray(activityEvent.type, ["machine.enrolled", "machine.connected"])}
          group by ${activityEvent.workspaceId})`,
      )
    : 0;
  const decisions = await purgeBefore(
    db,
    routeDecision,
    routeDecision.createdAt,
    cutoff,
    sql`${routeDecision.id} not in (select min(${routeDecision.id}) from ${routeDecision}
      where ${routeDecision.step} = 'machine' group by ${routeDecision.workspaceId})`,
  );
  return jobs + events + decisions;
}
