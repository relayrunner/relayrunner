import { type GithubActor, RouteWalk } from "@relayrunner/activity";
import { HOSTED_PROVIDER_IDS } from "@relayrunner/providers";
import { relayInputs } from "@relayrunner/runner-order";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
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
  // The relay job's id in the runner protocol (the claimed job message's jobId), which keys its
  // decision: each relay of an attempt keeps its own row. Null when unknown.
  pickJobId: string | null;
  // The Router's walk down the order, or null when the pick stopped before it.
  decision: RouteDecision | null;
  // Set when the relay failed: the message it failed with.
  reason: string | null;
}

/**
 * Keeps how a pick walked the runner order, so the run's jobs can say why they went where they did,
 * and logs a `job.unroutable` event when the relay failed. Each relay job of a run attempt keeps its
 * own decision; a redelivered pick for the same relay job keeps the first.
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
        pickJobId: pick.pickJobId,
        step: decision.runner === null ? null : decision.step,
        runner: decision.runner,
        skipped: decision.skipped,
        notInOrder: decision.notInOrder,
        ownOrder: Boolean(decision.ownOrder),
        machine: context.machine,
        github: context.github,
        hosted: hostedInputs(context),
        reason: decision.runner === null ? decision.reason : null,
        waitedAt: decision.runner !== null && decision.waited ? new Date() : null,
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
    ...(decision.ownOrder && { ownOrder: true }),
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

// A job to find the pick for. With `id` and `labels` (a workflow_job row), the pick is the one
// that answered one of the job's labels; without them (a run), the attempt's first pick.
type PickJob = JobKey & { id?: number; labels?: string[] };

/** What a job's run kept from its pick: the walk, and who started the run and the pick's attempt. */
export interface JobPick {
  walk: RouteWalk | null;
  // The attempt that picked, at or before the job's own.
  runAttempt: number;
  startedBy: GithubActor | null;
  triggeredBy: GithubActor | null;
}

/**
 * The pick behind each job: the newest decision for the job's repo and run at or before the job's
 * attempt (a re-run of failed jobs reuses the earlier attempt's pick). A run attempt can have
 * several picks, each answering its own job, so a job given with its labels takes the one whose
 * runner is among them, and otherwise (the relay itself, or a run) the attempt's first. Keyed by
 * `pickKey(job)`.
 */
export async function picksForJobs(db: Db, jobs: PickJob[]): Promise<Map<string, JobPick>> {
  const picks = new Map<string, JobPick>();
  // Asks by repo and run, so route_decision_pick_idx (repository_id, run_id, ...) answers it. Each
  // query takes up to 50 runs, which keeps it under D1's 100 bound values.
  const runs = [...new Map(jobs.map((job) => [`${job.repositoryId}:${job.runId}`, job])).values()];
  if (runs.length === 0) return picks;
  const chunks = await Promise.all(
    Array.from({ length: Math.ceil(runs.length / 50) }, (_, i) => {
      const chunk = runs.slice(i * 50, i * 50 + 50);
      return db
        .select()
        .from(table)
        .where(
          and(
            inArray(table.repositoryId, [...new Set(chunk.map((job) => job.repositoryId))]),
            inArray(table.runId, [...new Set(chunk.map((job) => job.runId))]),
          ),
        );
    }),
  );
  // Oldest first, so the first row of an attempt is its first pick.
  const rows = chunks.flat().sort((a, b) => a.id - b.id);
  for (const job of jobs) {
    const labels = new Set((job.labels ?? []).map((label) => label.toLowerCase()));
    let best: (typeof rows)[number] | undefined;
    let bestMatches = false;
    for (const row of rows) {
      if (row.repositoryId !== job.repositoryId || row.runId !== job.runId) continue;
      if (row.runAttempt > job.runAttempt) continue;
      const matches = row.runner !== null && labels.has(row.runner.toLowerCase());
      // A pick that answered the job's label wins over any other; then the newest attempt, then
      // the attempt's first pick.
      if (
        !best ||
        (matches && !bestMatches) ||
        (matches === bestMatches && row.runAttempt > best.runAttempt)
      ) {
        best = row;
        bestMatches = matches;
      }
    }
    if (!best) continue;
    const parsed = RouteWalk.safeParse({
      step: best.step,
      skipped: best.skipped,
      notInOrder: best.notInOrder,
      ...(best.ownOrder && { ownOrder: true }),
      machine: best.machine,
      github: best.github,
      ...best.hosted,
    });
    picks.set(pickKey(job), {
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

/** picksForJobs' key: the job's run attempt, and the job itself when it's given by id. */
export const pickKey = (job: PickJob) =>
  job.id === undefined ? jobKey(job) : `${jobKey(job)}:${job.id}`;

/**
 * The pick that answered `label` for a job's repo and run in an earlier attempt, or null when no
 * pick of that run did (the label was copied by hand, or from another run). "Re-run failed jobs"
 * doesn't re-run the relay, so a re-run job comes back on that earlier pick's label.
 */
export async function earlierPick(db: Db, job: JobKey & { label: string }) {
  const [row] = await db
    .select({
      runAttempt: table.runAttempt,
      machine: table.machine,
      github: table.github,
      hosted: table.hosted,
      startedById: table.startedById,
      startedByLogin: table.startedByLogin,
      triggeredById: table.triggeredById,
      triggeredByLogin: table.triggeredByLogin,
    })
    .from(table)
    .where(
      and(
        eq(table.repositoryId, job.repositoryId),
        eq(table.runId, job.runId),
        lt(table.runAttempt, job.runAttempt),
        eq(table.runner, job.label),
      ),
    )
    .orderBy(desc(table.runAttempt))
    .limit(1);
  if (!row) return null;
  return {
    runAttempt: row.runAttempt,
    inputs: relayInputs({ machine: row.machine, github: row.github, ...row.hosted }),
    startedBy: actor(row.startedById, row.startedByLogin),
    triggeredBy: actor(row.triggeredById, row.triggeredByLogin),
  };
}

/**
 * Whether a pick of this repo's run, in any attempt, answered `label`: the label is one our relay
 * made for this run, not one copied by hand or from another run.
 */
export async function pickedLabel(
  db: Db,
  job: { repositoryId: number; runId: number; label: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.repositoryId, job.repositoryId),
        eq(table.runId, job.runId),
        eq(table.runner, job.label),
      ),
    )
    .limit(1);
  return row !== undefined;
}
