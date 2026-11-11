import { type GithubActor, RouteWalk } from "@relayrunner/activity";
import { HOSTED_PROVIDER_IDS } from "@relayrunner/providers";
import { relayInputs } from "@relayrunner/runner-order";
import { inArray } from "drizzle-orm";
import { recordEvent } from "./activity.ts";
import { type Db, schema } from "./db/index.ts";
import type { JobContext, RouteDecision } from "./routing.ts";

const table = schema.routeDecision;

// What a pick knew when it answered, for the Activity page.
export interface PickRecord {
  workspaceId: string;
  // GitHub's repository id, or null when RelayRunner can't see the repo.
  repositoryId: number | null;
  context: JobContext;
  // The relay job's name, e.g. "relay".
  jobName: string | null;
  // The Router's walk down the order, or null when the pick stopped before it.
  decision: RouteDecision | null;
  // Set when the relay failed: the message it failed with.
  reason: string | null;
}

/**
 * Keeps how a pick walked the runner order, so the run's jobs can say why they went where they did,
 * and logs a `job.unroutable` event when the relay failed. A redelivered pick for the same run
 * attempt keeps the first decision.
 */
export async function recordPick(db: Db, pick: PickRecord) {
  const { context, decision } = pick;
  if (decision && pick.repositoryId !== null)
    await db
      .insert(table)
      .values({
        workspaceId: pick.workspaceId,
        repositoryId: pick.repositoryId,
        runId: context.runId,
        runAttempt: context.runAttempt,
        step: decision.runner === null ? null : decision.step,
        runner: decision.runner,
        skipped: decision.skipped,
        notInOrder: decision.notInOrder,
        machine: context.machine,
        github: context.github,
        hosted: hostedInputs(context),
        reason: decision.runner === null ? decision.reason : null,
        startedById: context.startedBy?.id ?? null,
        startedByLogin: context.startedBy?.login ?? null,
        triggeredById: context.triggeredBy?.id ?? null,
        triggeredByLogin: context.triggeredBy?.login ?? null,
      })
      .onConflictDoNothing();
  if (pick.reason !== null)
    await recordEvent(db, {
      workspaceId: pick.workspaceId,
      type: "job.unroutable",
      data: {
        repository: context.repo,
        runId: context.runId,
        runAttempt: context.runAttempt,
        workflow: context.workflow,
        job: pick.jobName,
        reason: pick.reason,
        walk: decision ? walkOf(decision, context) : null,
        startedBy: context.startedBy,
        triggeredBy: context.triggeredBy,
      },
    });
}

// The walk as the Activity page reads it.
function walkOf(decision: RouteDecision, context: JobContext): RouteWalk {
  return {
    step: decision.runner === null ? null : decision.step,
    skipped: decision.skipped,
    notInOrder: decision.notInOrder,
    ...relayInputs(context),
  };
}

// The hosted providers' inputs the relay set, for the route_decision `hosted` column.
function hostedInputs(context: JobContext) {
  return Object.fromEntries(
    HOSTED_PROVIDER_IDS.filter((id) => context[id].length > 0).map((id) => [id, context[id]]),
  );
}

type JobKey = { repositoryId: number; runId: number; runAttempt: number };

/** What a job's run kept from its pick: the walk, and who started the run and the pick's attempt. */
export interface JobPick {
  walk: RouteWalk | null;
  // The attempt that picked, at or before the job's own.
  runAttempt: number;
  startedBy: GithubActor | null;
  triggeredBy: GithubActor | null;
}

/**
 * The pick behind each job's run: the newest decision for the job's repo and run at or before the
 * job's attempt (a re-run of failed jobs reuses the earlier attempt's pick). Keyed by `key(job)`.
 */
export async function picksForJobs(db: Db, jobs: JobKey[]): Promise<Map<string, JobPick>> {
  const picks = new Map<string, JobPick>();
  const runIds = [...new Set(jobs.map((job) => job.runId))];
  if (runIds.length === 0) return picks;
  const rows = await db.select().from(table).where(inArray(table.runId, runIds));
  for (const job of jobs) {
    let best: (typeof rows)[number] | undefined;
    for (const row of rows) {
      if (row.repositoryId !== job.repositoryId || row.runId !== job.runId) continue;
      if (row.runAttempt > job.runAttempt) continue;
      if (!best || row.runAttempt > best.runAttempt) best = row;
    }
    if (!best) continue;
    const parsed = RouteWalk.safeParse({
      step: best.step,
      skipped: best.skipped,
      notInOrder: best.notInOrder,
      machine: best.machine,
      github: best.github,
      ...best.hosted,
    });
    picks.set(jobKey(job), {
      walk: parsed.success ? parsed.data : null,
      runAttempt: best.runAttempt,
      startedBy: actor(best.startedById, best.startedByLogin),
      triggeredBy: actor(best.triggeredById, best.triggeredByLogin),
    });
  }
  return picks;
}

export function actor(id: number | null, login: string | null): GithubActor | null {
  return login ? { id, login } : null;
}

export const jobKey = (job: JobKey) => `${job.repositoryId}:${job.runId}:${job.runAttempt}`;
