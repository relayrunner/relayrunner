// Automatic retries of jobs whose runner failed them (phase 1 of #448).
//
// When a run that RelayRunner routed finishes as failed, each of its routed jobs that failed is
// checked for a runner failure: the runner never got the job's steps going, the connected machine
// went offline mid-job, or GitHub reports it lost the runner. A failing step never counts. If one
// did and the workspace (or the repo's relayrunner.yml) turned retries on, the run's relay job is
// re-run through GitHub's API. That re-runs the failed job with it, and the relay picks again, so
// the retry can go to the same runner or another one (RetryRunner).
//
// GitHub refuses any re-run while a job of the run is still going, which is why this waits for
// the `workflow_run` `completed` event rather than the job's own.

import { type GithubActor, type RetryKind } from "@relayrunner/activity";
import { readRetrySettings, type RetryRunner, type RetrySettings } from "@relayrunner/runner-order";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { recordEvent } from "./activity.ts";
import { createDb, type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { appInstallationToken, jobAnnotations, rerunJob } from "./github-app.ts";
import { loadRepoConfig } from "./repo-config.ts";
import { actor } from "./route-decisions.ts";
import { DAY_MS } from "./job-timings.ts";
import { errorMessage } from "./webhook-queue.ts";

type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;

const table = schema.jobRetry;

// A workspace retries at most this many runs a day, however its settings read, so a broken
// provider can't turn every failure into a second bill.
const DAILY_RETRY_CAP = 100;
// A machine that went offline this soon after its job ended still counts as having dropped it:
// GitHub can mark the job failed before the socket's close reaches us.
const DISCONNECT_SLACK_MS = 2 * 60_000;

// What GitHub writes on a job whose runner went away mid-job.
const LOST_RUNNER = [/lost communication with the server/i, /received a shutdown signal/i];

/** A routed job that failed, with what's needed to judge whether its runner failed it. */
export interface FailedJob {
  id: number;
  name: string;
  ranSteps: boolean | null;
  machineId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Why a job's runner failed it, from what RelayRunner already knows, or null when that can't say:
 * the job ended in GitHub's setup (`runner_start`), or the machine running it went offline while it
 * ran (`machine_lost`). `disconnectedAt` lists the job's machine's disconnects.
 */
export function classifyFailure(job: FailedJob, disconnectedAt: Date[]): RetryKind | null {
  if (job.ranSteps === false) return "runner_start";
  if (job.machineId && job.startedAt) {
    const from = job.startedAt.getTime();
    const to = (job.completedAt?.getTime() ?? from) + DISCONNECT_SLACK_MS;
    if (disconnectedAt.some((at) => at.getTime() >= from && at.getTime() <= to))
      return "machine_lost";
  }
  return null;
}

/** Whether GitHub's annotations on a job say its runner went away. */
export const lostRunner = (messages: string[]) =>
  messages.some((message) => LOST_RUNNER.some((pattern) => pattern.test(message)));

/**
 * The settings that apply to a repo: its relayrunner.yml `retry:` when it has one, else the
 * workspace's.
 */
export function effectiveSettings(
  workspace: RetrySettings,
  repo: Partial<RetrySettings> | false | null,
): RetrySettings {
  if (repo === false) return { ...workspace, enabled: false };
  if (!repo) return workspace;
  return { ...workspace, enabled: true, ...repo };
}

/**
 * On a routed run's `completed` webhook: retries its first routed job whose runner failed it, when
 * retries are on for the repo and the run is under its cap. Writes the retry record before asking
 * GitHub, so a redelivered webhook never retries twice.
 */
export async function retryFailedRun(env: Env, message: WorkflowRunMessage): Promise<void> {
  const { run, repository, installationId } = message;
  if (message.action !== "completed" || run.conclusion !== "failure" || !installationId) return;
  const db = createDb(env.DB);
  const [[workspace], failed] = await Promise.all([
    db
      .select({ id: schema.workspace.id, retrySettings: schema.workspace.retrySettings })
      .from(schema.workspace)
      .where(eq(schema.workspace.installationId, installationId))
      .limit(1),
    failedRoutedJobs(db, repository.id, run.id, run.runAttempt),
  ]);
  if (!workspace || !failed) return;
  const log = { repository: repository.fullName, runId: run.id, runAttempt: run.runAttempt };

  // Retries can be on for the repo even when the workspace leaves them off, so read its file.
  const token = await appInstallationToken(env, installationId);
  const config = await loadRepoConfig(token, repository.fullName);
  const settings = effectiveSettings(
    readRetrySettings(workspace.retrySettings),
    config.kind === "config" ? config.retry : null,
  );
  if (!settings.enabled) return;

  const found = await findRunnerFailure(db, token, workspace.id, repository.fullName, failed.jobs);
  if (!found) return;
  if (!(await underCaps(db, workspace.id, repository.id, run.id, settings.max))) {
    console.log(JSON.stringify({ msg: "retry skipped: cap reached", ...log }));
    return;
  }

  // A retry's own attempt is credited to the App: keep the starter of the attempt it retried.
  const triggeredBy =
    (await retryOf(db, repository.id, run.id, run.runAttempt))?.triggeredBy ?? run.triggeredBy;
  const [record] = await db
    .insert(table)
    .values({
      workspaceId: workspace.id,
      repositoryId: repository.id,
      runId: run.id,
      runAttempt: run.runAttempt,
      jobId: found.job.id,
      relayJobId: failed.relay.id,
      kind: found.kind,
      runner: settings.runner,
      failedStep: failed.step,
      failedMachineId: found.job.machineId,
      triggeredById: triggeredBy?.id ?? null,
      triggeredByLogin: triggeredBy?.login ?? null,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: table.id });
  // Another delivery of this webhook already handled the attempt.
  if (!record) return;

  let error: string | null;
  try {
    error = await rerunJob(token, repository.fullName, failed.relay.id);
  } catch (caught) {
    error = errorMessage(caught);
  }
  await db
    .update(table)
    .set({ status: error ? "failed" : "requested", error })
    .where(eq(table.id, record.id));
  console.log(
    JSON.stringify({
      msg: error ? "retry refused" : "retry requested",
      ...log,
      jobId: found.job.id,
      kind: found.kind,
      runner: settings.runner,
      error,
    }),
  );
  if (error) return;
  await recordEvent(db, {
    workspaceId: workspace.id,
    type: "job.retried",
    data: {
      repository: repository.fullName,
      runId: run.id,
      runAttempt: run.runAttempt,
      workflow: run.workflowName,
      job: found.job.name,
      kind: found.kind,
      runner: settings.runner,
      failedOn: await failedOn(db, found.job.machineId, failed.label),
    },
  });
}

/**
 * The attempt's failed jobs that its pick routed, the relay job to re-run, and where the pick sent
 * them. Null when there's nothing to retry: no pick, more than one (each would need its own
 * retry), or no routed job failed.
 */
async function failedRoutedJobs(db: Db, repositoryId: number, runId: number, runAttempt: number) {
  const jobs = await db
    .select({
      id: schema.workflowJob.id,
      kind: schema.workflowJob.kind,
      name: schema.workflowJob.name,
      labels: schema.workflowJob.labels,
      conclusion: schema.workflowJob.conclusion,
      ranSteps: schema.workflowJob.ranSteps,
      machineId: schema.workflowJob.machineId,
      runAttempt: schema.workflowJob.runAttempt,
      startedAt: schema.workflowJob.startedAt,
      completedAt: schema.workflowJob.completedAt,
    })
    .from(schema.workflowJob)
    .where(
      and(
        eq(schema.workflowJob.repositoryId, repositoryId),
        eq(schema.workflowJob.runId, runId),
        lte(schema.workflowJob.runAttempt, runAttempt),
      ),
    );
  // "Re-run failed jobs" reuses an earlier attempt's relay, so take the newest one at or before it.
  const relays = jobs.filter((job) => job.kind === "pick");
  const newest = Math.max(...relays.map((job) => job.runAttempt));
  const latest = relays.filter((job) => job.runAttempt === newest);
  if (latest.length !== 1) return null;
  const [decision] = await db
    .select({ step: schema.routeDecision.step, runner: schema.routeDecision.runner })
    .from(schema.routeDecision)
    .where(
      and(
        eq(schema.routeDecision.repositoryId, repositoryId),
        eq(schema.routeDecision.runId, runId),
        lte(schema.routeDecision.runAttempt, runAttempt),
      ),
    )
    .orderBy(desc(schema.routeDecision.runAttempt))
    .limit(1);
  if (!decision?.runner) return null;
  const label = decision.runner;
  // A job the pick placed: on a machine's route, or on the label it answered.
  const failed = jobs.filter(
    (job) =>
      job.kind === "job" &&
      job.runAttempt === runAttempt &&
      job.conclusion === "failure" &&
      (job.machineId !== null || job.labels.includes(label)),
  );
  if (failed.length === 0) return null;
  return { relay: latest[0]!, jobs: failed, step: decision.step, label };
}

// The first job whose runner failed it: what RelayRunner knows first, then GitHub's annotations.
async function findRunnerFailure(
  db: Db,
  token: string,
  workspaceId: string,
  repo: string,
  jobs: FailedJob[],
) {
  // The disconnects of every machine the failed jobs ran on, from the first one's start.
  const machineIds = [...new Set(jobs.flatMap((job) => (job.machineId ? [job.machineId] : [])))];
  const starts = jobs.flatMap((job) => (job.machineId && job.startedAt ? [job.startedAt] : []));
  const disconnects =
    starts.length > 0
      ? await db
          .select({
            machineId: schema.activityEvent.machineId,
            at: schema.activityEvent.occurredAt,
          })
          .from(schema.activityEvent)
          .where(
            and(
              eq(schema.activityEvent.workspaceId, workspaceId),
              eq(schema.activityEvent.type, "machine.disconnected"),
              gte(schema.activityEvent.occurredAt, new Date(Math.min(...starts.map(Number)))),
              inArray(schema.activityEvent.machineId, machineIds),
            ),
          )
      : [];
  for (const job of jobs) {
    const at = disconnects.flatMap((row) => (row.machineId === job.machineId ? [row.at] : []));
    const kind = classifyFailure(job, at);
    if (kind) return { job, kind };
  }
  // GitHub's word, asked for every job at once; the first in order wins.
  const lost = await Promise.all(
    jobs.map(async (job) => {
      if (job.ranSteps === false) return false;
      try {
        return lostRunner(await jobAnnotations(token, repo, job.id));
      } catch (error) {
        console.warn(
          JSON.stringify({
            msg: "job annotations unavailable",
            jobId: job.id,
            error: errorMessage(error),
          }),
        );
        return false;
      }
    }),
  );
  const job = jobs.find((_, index) => lost[index]);
  return job ? { job, kind: "runner_lost" as const } : null;
}

// Under the run's `max` retries and the workspace's daily cap.
async function underCaps(
  db: Db,
  workspaceId: string,
  repositoryId: number,
  runId: number,
  max: number,
) {
  const [[perRun], [perDay]] = await Promise.all([
    db
      .select({ n: count() })
      .from(table)
      .where(and(eq(table.repositoryId, repositoryId), eq(table.runId, runId))),
    db
      .select({ n: count() })
      .from(table)
      .where(
        and(
          eq(table.workspaceId, workspaceId),
          gte(table.createdAt, new Date(Date.now() - DAY_MS)),
        ),
      ),
  ]);
  return (perRun?.n ?? 0) < max && (perDay?.n ?? 0) < DAILY_RETRY_CAP;
}

// The machine's name, or the label the job failed on.
async function failedOn(db: Db, machineId: string | null, label: string) {
  if (!machineId) return label;
  const [machine] = await db
    .select({ name: schema.machine.name })
    .from(schema.machine)
    .where(eq(schema.machine.id, machineId))
    .limit(1);
  return machine?.name ?? null;
}

/** What a retry's pick needs: where the retry goes, where it failed, and who started it. */
export interface RetryPick {
  runner: RetryRunner;
  failedStep: string | null;
  failedMachineId: string | null;
  triggeredBy: GithubActor | null;
}

/**
 * The retry that started `runAttempt`, when RelayRunner asked GitHub for it: the record of the
 * attempt before. Null for any other attempt.
 */
export async function retryOf(
  db: Db,
  repositoryId: number,
  runId: number,
  runAttempt: number,
): Promise<RetryPick | null> {
  if (runAttempt <= 1) return null;
  const [row] = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.repositoryId, repositoryId),
        eq(table.runId, runId),
        eq(table.runAttempt, runAttempt - 1),
        eq(table.status, "requested"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    runner: row.runner,
    failedStep: row.failedStep,
    failedMachineId: row.failedMachineId,
    triggeredBy: actor(row.triggeredById, row.triggeredByLogin),
  };
}
