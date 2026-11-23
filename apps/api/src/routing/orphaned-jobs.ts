// A backstop for routed jobs (src/routing/stranded-jobs.ts covers the paths that know a job is stuck): a
// job queued on a route's `rr-<id>` label that the Router no longer has in hand would sit queued
// for GitHub's 24 hours, since only the runner minted for that route has the label. Every 15
// minutes (src/routing/pick-sweep.ts) such jobs are ended with the `orphaned` reason, so the run finishes
// and automatic retries re-run the relay, which picks a runner again.

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { workspaceIdForInstallation } from "../github/installations.ts";
import { pickedLabel } from "./route-decisions.ts";
import { routeIdFromLabels, routeLabel } from "./routing.ts";
import { strandedJobName } from "./stranded-jobs.ts";

// How long a routed job may stay queued before the sweep looks at it. A job its machine is about
// to take is still the Router's (Router.holds), so this only has to outlast the queued webhook's
// own hand-off; one older than a day GitHub has given up on.
export const ORPHANED_AFTER_MS = 10 * 60_000;
const ORPHANED_WINDOW_MS = 24 * 60 * 60_000;
// Jobs looked at per sweep, newest first, and how many at once.
export const MAX_ORPHANED = 200;
const ORPHANED_BATCH = 25;

type Outcome = "ended" | "held" | "not_ours" | "skipped";

/**
 * Ends the routed jobs still queued on our own `rr-<id>` label that nothing will take. Left alone:
 * a label no pick of the job's repo and run answered (copied by hand or from another run), and a
 * job the Router still holds (waiting in line for a full machine, or claimed by a live route).
 * StrandedJob asks GitHub before it ends one, so a job our row still has as queued but that
 * already started or finished is left too. There's no helper that corrects that stale row from
 * GitHub's answer (workflowJobStatus has no conclusion), so the row stays as it is; StrandedJob is
 * one per route and job, so later sweeps don't ask GitHub again.
 */
export async function sweepOrphanedJobs(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const labels = schema.workflowJob.labels;
  const queued = await db
    .select({
      id: schema.workflowJob.id,
      installationId: schema.workflowJob.installationId,
      repositoryId: schema.workflowJob.repositoryId,
      repo: schema.workflowJob.repositoryFullName,
      runId: schema.workflowJob.runId,
      labels,
    })
    .from(schema.workflowJob)
    .where(
      and(
        eq(schema.workflowJob.kind, "job"),
        eq(schema.workflowJob.status, "queued"),
        lt(schema.workflowJob.githubCreatedAt, new Date(now - ORPHANED_AFTER_MS)),
        gt(schema.workflowJob.githubCreatedAt, new Date(now - ORPHANED_WINDOW_MS)),
        // Only jobs on a route label, so jobs waiting on GitHub's or a provider's runners don't
        // use up the cap.
        sql`lower(${labels}) like '%"rr-%'`,
      ),
    )
    .orderBy(desc(schema.workflowJob.githubCreatedAt))
    .limit(MAX_ORPHANED);

  const workspaces = new Map<number, Promise<string | null>>();
  const workspaceOf = (installationId: number) => {
    let id = workspaces.get(installationId);
    if (!id) workspaces.set(installationId, (id = workspaceIdForInstallation(db, installationId)));
    return id;
  };

  const sweepOne = async (job: (typeof queued)[number]): Promise<Outcome> => {
    // Exactly one route label: a job that names several isn't one our relay answered.
    const routeLabels = job.labels.filter((label) => routeIdFromLabels([label]) !== null);
    const routeId = routeLabels.length === 1 ? routeIdFromLabels(routeLabels) : null;
    if (!routeId) return "skipped";
    const ours = await pickedLabel(db, {
      repositoryId: job.repositoryId,
      runId: job.runId,
      label: routeLabel(routeId),
    });
    if (!ours) return "not_ours";
    const workspaceId = await workspaceOf(job.installationId);
    if (!workspaceId) return "skipped";
    const held = await env.ROUTER.getByName(workspaceId).holds(routeId, {
      jobId: job.id,
      repositoryId: job.repositoryId,
      runId: job.runId,
    });
    if (held) return "held";
    const started = await env.STRANDED_JOB.getByName(strandedJobName(routeId, job.id)).start({
      routeId,
      jobId: job.id,
      installationId: job.installationId,
      repo: job.repo,
      reason: "orphaned",
    });
    // Already started by an earlier sweep or by the Router: nothing new.
    if (!started) return "skipped";
    console.log(
      JSON.stringify({
        msg: "relayrunner orphaned job ended",
        jobId: job.id,
        runId: job.runId,
        repo: job.repo,
        routeId,
      }),
    );
    return "ended";
  };

  const counts: Record<Outcome | "failed", number> = {
    ended: 0,
    held: 0,
    not_ours: 0,
    skipped: 0,
    failed: 0,
  };
  for (let i = 0; i < queued.length; i += ORPHANED_BATCH) {
    const results = await Promise.allSettled(queued.slice(i, i + ORPHANED_BATCH).map(sweepOne));
    results.forEach((result, j) => {
      if (result.status === "fulfilled") counts[result.value]++;
      else {
        // One job failing (its Router or D1 hiccups) shouldn't stop the others.
        counts.failed++;
        console.warn(
          JSON.stringify({
            msg: "relayrunner orphaned job not swept",
            jobId: queued[i + j]!.id,
            error: errorMessage(result.reason),
          }),
        );
      }
    });
  }
  console.log(
    JSON.stringify({ msg: "relayrunner orphaned jobs swept", queued: queued.length, ...counts }),
  );
  return counts;
}
