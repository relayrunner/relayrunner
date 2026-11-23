// Writes to a workspace's Activity log. Reading it, for the Activity page, is activity.ts.
import { ActivityEvent } from "@relayrunner/activity";
import { type Db, schema } from "./db/index.ts";

const table = schema.activityEvent;

export type NewActivityEvent = ActivityEvent & {
  workspaceId: string;
  machineId?: string | null;
  jobId?: number | null;
  actorUserId?: string | null;
  occurredAt?: Date;
};

/**
 * Appends an event to the workspace's Activity log. `data` is checked against its type's schema,
 * so a bad event throws here instead of breaking the page later. A job's event is written at most
 * once per type: a repeat (a redelivered webhook) is ignored.
 */
export async function recordEvent(db: Db, event: NewActivityEvent) {
  const { type, data } = ActivityEvent.parse({ type: event.type, data: event.data });
  await db
    .insert(table)
    .values({
      workspaceId: event.workspaceId,
      type,
      data,
      machineId: event.machineId ?? null,
      jobId: event.jobId ?? null,
      actorUserId: event.actorUserId ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    })
    .onConflictDoNothing();
}
