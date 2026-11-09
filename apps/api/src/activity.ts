import {
  ActivityEvent,
  type ActivityItem,
  type ActivityOptions,
  type ActivityPage,
  type ActivityQuery,
  type ActivityResult,
  type DisconnectReason,
  type RouteWalk,
} from "@relayrunner/activity";
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type Db, schema } from "./db/index.ts";
import { presentJob } from "./jobs.ts";
import { jobKey, walksForJobs } from "./route-decisions.ts";

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

/**
 * Logs a machine event in the machine's workspace, with the machine's current name. Does nothing
 * if the machine row is gone.
 */
export async function recordMachineEvent(
  db: Db,
  machineId: string,
  event:
    | { type: "machine.connected"; data: { runnerVersion: string | null } }
    | { type: "machine.disconnected"; data: { reason: DisconnectReason } },
) {
  const [machine] = await db
    .select({ workspaceId: schema.machine.workspaceId, name: schema.machine.name })
    .from(schema.machine)
    .where(eq(schema.machine.id, machineId))
    .limit(1);
  if (!machine) return;
  // recordEvent checks the assembled data against the type's schema.
  await recordEvent(db, {
    workspaceId: machine.workspaceId,
    machineId,
    type: event.type,
    data: { machineName: machine.name, ...event.data },
  } as NewActivityEvent);
}

export const ACTIVITY_PAGE_SIZE = 50;

const eventMachine = alias(schema.machine, "event_machine");
const jobMachine = alias(schema.machine, "job_machine");

const job = schema.workflowJob;
const dataField = (path: string) => sql<string>`json_extract(${table.data}, ${path})`;
const isCheck = (conclusion: "success" | "failure") =>
  and(eq(table.type, "check.completed"), eq(dataField("$.conclusion"), conclusion));

// Each result as a condition on the event and its job (left-joined, so null for other events).
const RESULTS: Record<ActivityResult, SQL | undefined> = {
  passed: or(eq(job.conclusion, "success"), isCheck("success")),
  failed: or(
    inArray(job.conclusion, ["failure", "timed_out"]),
    isCheck("failure"),
    eq(table.type, "job.unroutable"),
  ),
  cancelled: eq(job.conclusion, "cancelled"),
  skipped: eq(job.conclusion, "skipped"),
  running: and(isNotNull(job.id), isNull(job.conclusion)),
};

/**
 * The workspace's Activity log, newest first. `before` is an event id from a previous page; the
 * rest narrow it (see ActivityQuery).
 */
export async function listActivity(
  db: Db,
  workspaceId: string,
  { before, filter, since, repository, result, machine }: ActivityQuery & { before?: number } = {},
): Promise<ActivityPage> {
  const rows = await db
    .select({
      event: table,
      actorName: schema.user.name,
      eventMachineName: eventMachine.name,
      job,
      jobMachineName: jobMachine.name,
      private: schema.githubRepository.private,
    })
    .from(table)
    .leftJoin(schema.user, eq(schema.user.id, table.actorUserId))
    .leftJoin(eventMachine, eq(eventMachine.id, table.machineId))
    .leftJoin(job, eq(job.id, table.jobId))
    .leftJoin(jobMachine, eq(jobMachine.id, job.machineId))
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, job.repositoryId))
    .where(
      and(
        eq(table.workspaceId, workspaceId),
        before === undefined ? undefined : lt(table.id, before),
        filter === undefined ? undefined : like(table.type, `${filter}.%`),
        since === undefined ? undefined : gte(table.occurredAt, new Date(since)),
        repository === undefined
          ? undefined
          : or(
              eq(job.repositoryFullName, repository),
              and(isNull(table.jobId), eq(dataField("$.repository"), repository)),
            ),
        result === undefined ? undefined : RESULTS[result],
        machine === undefined
          ? undefined
          : or(eq(table.machineId, machine), eq(job.machineId, machine)),
      ),
    )
    .orderBy(desc(table.id))
    .limit(ACTIVITY_PAGE_SIZE + 1);
  const page = rows.slice(0, ACTIVITY_PAGE_SIZE);
  const walks = await walksForJobs(
    db,
    page.flatMap((row) => (row.job ? [row.job] : [])),
  );
  const items = page.flatMap((row) => {
    const item = presentEvent(row, row.job ? (walks.get(jobKey(row.job)) ?? null) : null);
    return item ? [item] : [];
  });
  return {
    items: await foldJobsNotRun(db, workspaceId, items),
    nextBefore: rows.length > ACTIVITY_PAGE_SIZE ? page[page.length - 1].event.id : null,
  };
}

/** What the Activity page's repo and machine filters can choose from. */
export async function activityOptions(db: Db, workspaceId: string): Promise<ActivityOptions> {
  const repo = schema.githubRepository;
  const installation = schema.githubInstallation;
  const [repositories, machines] = await Promise.all([
    db
      .select({ name: repo.fullName })
      .from(repo)
      .innerJoin(installation, eq(installation.id, repo.installationId))
      .where(and(eq(installation.workspaceId, workspaceId), isNull(repo.removedAt)))
      .orderBy(repo.fullName),
    db
      .select({ id: schema.machine.id, name: schema.machine.name })
      .from(schema.machine)
      // The same machines the Runners page lists. Each enrollment is its own row, so a laptop
      // enrolled, revoked and enrolled again leaves a revoked row per round, and an approved code
      // the CLI never claimed leaves one with no os. Neither belongs in the picker.
      .where(
        and(
          eq(schema.machine.workspaceId, workspaceId),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
        ),
      )
      .orderBy(schema.machine.name),
  ]);
  return { repositories: repositories.map((row) => row.name), machines };
}

type WorkflowJob = typeof schema.workflowJob.$inferSelect;

const runKey = (repository: string, runId: number, runAttempt: number) =>
  `${repository}:${runId}:${runAttempt}`;

// A job GitHub never sent anywhere: no labels (its `runs-on` was never worked out, because a job it
// needs failed) and no machine. A relay that couldn't route leaves its dependents like this.
function neverRouted(job: Pick<WorkflowJob, "labels" | "machineId" | "conclusion">) {
  return job.conclusion === "skipped" && job.labels.length === 0 && !job.machineId;
}

/**
 * Shows a run that couldn't route as one entry: each `job.unroutable` gets the names of the jobs
 * that needed its relay (`jobsNotRun`), and those jobs' own rows are dropped, wherever the relay's
 * entry sits in the log. A never-routed job whose run has no such entry (logged before relays
 * failed fast) keeps its row.
 */
async function foldJobsNotRun(
  db: Db,
  workspaceId: string,
  items: ActivityItem[],
): Promise<ActivityItem[]> {
  const relays = items.flatMap((item) => (item.type === "job.unroutable" ? [item] : []));
  const orphans = items.flatMap((item) =>
    item.job && neverRouted(rawJob(item.job)) ? [item.job] : [],
  );
  if (relays.length === 0 && orphans.length === 0) return items;

  // The never-routed jobs of every unroutable run on this page.
  const notRun = new Map<string, string[]>();
  const relayRuns = [...new Set(relays.map((item) => item.data.runId))];
  if (relayRuns.length) {
    const jobs = await db
      .select({
        name: job.name,
        repository: job.repositoryFullName,
        runId: job.runId,
        runAttempt: job.runAttempt,
        labels: job.labels,
        machineId: job.machineId,
        conclusion: job.conclusion,
      })
      .from(job)
      .innerJoin(schema.githubInstallation, eq(schema.githubInstallation.id, job.installationId))
      .where(
        and(
          eq(schema.githubInstallation.workspaceId, workspaceId),
          inArray(job.runId, relayRuns),
          eq(job.kind, "job"),
        ),
      )
      .orderBy(asc(job.githubCreatedAt), asc(job.id));
    for (const row of jobs) {
      if (!neverRouted(row)) continue;
      const key = runKey(row.repository, row.runId, row.runAttempt);
      notRun.set(key, [...(notRun.get(key) ?? []), row.name]);
    }
  }

  // The runs, on this page or not, whose relay logged that it couldn't route.
  const unroutable = new Set<string>();
  const orphanRuns = [...new Set(orphans.map((job) => job.runId))];
  if (orphanRuns.length) {
    const events = await db
      .select({ data: table.data })
      .from(table)
      .where(
        and(
          eq(table.workspaceId, workspaceId),
          eq(table.type, "job.unroutable"),
          inArray(dataField("$.runId"), orphanRuns),
        ),
      );
    for (const { data } of events) {
      const { repository, runId, runAttempt } = data as {
        repository: string;
        runId: number;
        runAttempt: number;
      };
      unroutable.add(runKey(repository, runId, runAttempt));
    }
  }

  return items.flatMap<ActivityItem>((item) => {
    if (item.type === "job.unroutable") {
      const { repository, runId, runAttempt } = item.data;
      return [{ ...item, jobsNotRun: notRun.get(runKey(repository, runId, runAttempt)) ?? [] }];
    }
    const job = item.job;
    if (
      job &&
      neverRouted(rawJob(job)) &&
      unroutable.has(runKey(job.repository, job.runId, job.runAttempt))
    )
      return [];
    return [item];
  });
}

// The fields neverRouted reads, from a job as the log presents it.
function rawJob(job: NonNullable<ActivityItem["job"]>) {
  return {
    conclusion: job.conclusion,
    labels: job.runner.type !== "machine" && job.runner.label ? [job.runner.label] : [],
    machineId: job.runner.type === "machine" ? "machine" : null,
  };
}

type Row = {
  event: typeof table.$inferSelect;
  actorName: string | null;
  eventMachineName: string | null;
  job: typeof schema.workflowJob.$inferSelect | null;
  jobMachineName: string | null;
  private: boolean | null;
};

// Null for a row whose type or data no longer parses (a type that was since removed), so one bad
// row never breaks the page.
function presentEvent(row: Row, walk: RouteWalk | null): ActivityItem | null {
  const parsed = ActivityEvent.safeParse({ type: row.event.type, data: row.event.data });
  if (!parsed.success) return null;
  const event = parsed.data;
  const snapshot = "machineName" in event.data ? event.data.machineName : null;
  return {
    ...event,
    id: row.event.id,
    occurredAt: row.event.occurredAt.toISOString(),
    actor:
      row.event.actorUserId && row.actorName
        ? { id: row.event.actorUserId, name: row.actorName }
        : null,
    machine:
      snapshot === null
        ? null
        : { id: row.event.machineId, name: row.eventMachineName ?? snapshot },
    job: row.job ? presentJob(row.job, row.private, row.jobMachineName, walk) : null,
  };
}
