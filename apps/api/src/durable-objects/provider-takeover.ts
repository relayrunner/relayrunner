import { recordEvent } from "../ingest/activity-log.ts";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import type { HostedProviderId } from "@relayrunner/providers";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import {
  rerunJob,
  runAttemptStatus,
  runAttemptTriggeringActor,
  workflowJobRunner,
} from "../github/actions-api.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { deleteRunner } from "../github/runners-api.ts";
import { installationRunnerScope } from "../github/installations.ts";
import {
  MAX_TAKEOVER_ATTEMPT,
  RERUN_GIVE_UP_MS,
  RERUN_POLL_MS,
  TAKEOVER_AFTER_MS,
  TAKEOVER_WAIT_MS,
  takeoverMessage,
  takeoverRunnerName,
} from "../routing/provider-takeover.ts";
import { mintRepoFirst } from "../routing/repo-runner.ts";
import { routedRun } from "../routing/retries.ts";
import {
  decodeJitConfig,
  latestRunnerVersion,
  RunnerClient,
  waitForJob,
} from "../routing/runner-protocol.ts";
import { traced } from "../tracing.ts";
import { log } from "../log.ts";

export interface TakeoverWork {
  jobId: number;
  jobName: string;
  workflow: string | null;
  installationId: number;
  workspaceId: string;
  repo: string;
  repositoryId: number;
  runId: number;
  runAttempt: number;
  key: HostedProviderId;
  label: string;
  // When GitHub queued the job (epoch ms).
  queuedAt: number;
}

type Phase = "takeover" | "rerun";

// One per routed job on a hosted provider's label (src/routing/provider-takeover.ts), addressed by
// takeoverName. A minute after the job queued it asks GitHub whether a runner took it. If one did,
// the provider can see the repo. If not, it acts as a one-job runner on the job's label, claims the
// job and fails it with the reason, tells the Router the provider missed the repo, and once the
// run finishes re-runs its relay so the pick goes elsewhere.
export class ProviderTakeover extends DurableObject<Env> {
  // Idempotent: a job is only watched once. True when this call started it.
  async start(work: TakeoverWork): Promise<boolean> {
    if (await this.ctx.storage.get("work")) return false;
    await this.ctx.storage.put({ work, phase: "takeover" satisfies Phase });
    await this.ctx.storage.setAlarm(Math.max(Date.now(), work.queuedAt + TAKEOVER_AFTER_MS));
    return true;
  }

  async alarm() {
    const work = await this.ctx.storage.get<TakeoverWork>("work");
    const phase = await this.ctx.storage.get<Phase>("phase");
    if (!work || !phase) return;
    const ids = {
      workspaceId: work.workspaceId,
      jobId: work.jobId,
      repo: work.repo,
      runId: work.runId,
      provider: work.key,
    };
    let result: string;
    try {
      result = await traced(
        `takeover.${phase}`,
        { "github.job_id": work.jobId, "github.repository": work.repo },
        () => (phase === "takeover" ? this.takeover(work) : this.rerun(work)),
      );
    } catch (error) {
      result = "error";
      log.error("takeover.failed", "takeover failed", { phase, ...ids, error });
    }
    log.info("takeover.checked", "takeover checked", { phase, ...ids, result });
  }

  private async takeover(work: TakeoverWork) {
    // "Skip runners that stop picking up jobs" off: the workspace wants its jobs to wait.
    const [workspace] = await createDb(this.env.DB)
      .select({ skip: schema.workspace.skipUnhealthyRunners })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, work.workspaceId))
      .limit(1);
    if (workspace?.skip === false) return "off";
    const token = await appInstallationToken(this.env, work.installationId);
    const router = this.env.ROUTER.getByName(work.workspaceId);
    const job = await workflowJobRunner(token, work.repo, work.jobId);
    if (job?.status !== "queued") {
      // A runner took it, so the provider can see the repo. One cancelled while queued says
      // nothing either way.
      if (job?.runnerName && job.runnerName !== takeoverRunnerName(work.jobId))
        await router.providerPicked(work.key, work.repositoryId);
      return job ? "picked_up" : "gone";
    }
    const ended = await endJob(this.env, token, work);
    if (ended !== "ended") return ended;
    await router.providerMissed(work.key, work.repositoryId);
    if (work.runAttempt >= MAX_TAKEOVER_ATTEMPT) return "ended_no_rerun";
    await this.ctx.storage.put("phase", "rerun" satisfies Phase);
    await this.ctx.storage.setAlarm(Date.now() + RERUN_POLL_MS);
    return "ended";
  }

  // Once the run's attempt finishes, re-runs its relay (GitHub re-runs the jobs that need it with
  // it). Written to job_retry first, like an automatic retry, so a retry of the same attempt can't
  // also re-run it, and the retry's pick moves the provider that missed to the end of the order.
  private async rerun(work: TakeoverWork) {
    const token = await appInstallationToken(this.env, work.installationId);
    const status = await runAttemptStatus(token, work.repo, work.runId, work.runAttempt);
    if (status !== "completed") {
      if (Date.now() - work.queuedAt > RERUN_GIVE_UP_MS) return "gave_up";
      await this.ctx.storage.setAlarm(Date.now() + RERUN_POLL_MS);
      return "waiting";
    }
    const db = createDb(this.env.DB);
    const routed = await routedRun(db, work.repositoryId, work.runId, work.runAttempt);
    // Several relays in one run: each would need its own re-run, so the job's message says why.
    if (!routed) return "no_relay";
    const triggeredBy = await runAttemptTriggeringActor(
      token,
      work.repo,
      work.runId,
      work.runAttempt,
    ).catch(() => null);
    const table = schema.jobRetry;
    const [record] = await db
      .insert(table)
      .values({
        workspaceId: work.workspaceId,
        repositoryId: work.repositoryId,
        runId: work.runId,
        runAttempt: work.runAttempt,
        jobId: work.jobId,
        relayJobId: routed.relay.id,
        kind: "provider_missed",
        runner: "other",
        failedStep: work.key,
        failedMachineId: null,
        triggeredById: triggeredBy?.id ?? null,
        triggeredByLogin: triggeredBy?.login ?? null,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: table.id });
    // An automatic retry already re-ran this attempt.
    if (!record) return "already_retried";
    let error: string | null;
    try {
      error = await rerunJob(token, work.repo, routed.relay.id);
    } catch (caught) {
      error = errorMessage(caught);
    }
    await db
      .update(table)
      .set({ status: error ? "failed" : "requested", error })
      .where(eq(table.id, record.id));
    if (error) return `rerun_refused: ${error}`;
    await recordEvent(db, {
      workspaceId: work.workspaceId,
      type: "job.retried",
      data: {
        repository: work.repo,
        runId: work.runId,
        runAttempt: work.runAttempt,
        workflow: work.workflow,
        job: work.jobName,
        kind: "provider_missed",
        runner: "other",
        failedOn: work.label,
      },
    });
    return "rerun";
  }
}

// Registers a one-job runner on the job's label for the repo, and fails the job GitHub offers it.
// Another job of the repo queued on the same label may come instead: it hasn't been picked up
// either, so it's ended the same way.
async function endJob(env: Env, token: string, work: TakeoverWork) {
  const db = createDb(env.DB);
  const [{ jit, scope }, version] = await Promise.all([
    mintRepoFirst(
      token,
      work.repo,
      { name: takeoverRunnerName(work.jobId), labels: [work.label] },
      {
        fallbackScope: () => installationRunnerScope(db, work.installationId, work.repo),
        log: { msg: "relayrunner takeover runner registered on the org", jobId: work.jobId },
      },
    ),
    latestRunnerVersion(),
  ]);
  // GitHub removes a JIT runner once its job is done; until then, this one is ours to remove.
  let registered = true;
  const client = new RunnerClient(decodeJitConfig(jit.encodedJitConfig), version);
  try {
    await client.openSession();
    const request = await waitForJob(client, TAKEOVER_WAIT_MS);
    if (!request) return "no_job";
    const job = await client.claim(request);
    registered = false;
    await client.complete(job, "failed", { error: takeoverMessage(work.key) });
    return "ended";
  } finally {
    await client.closeSession().catch((error) => logCleanup("close session", work, error));
    // A runner left registered could take a job nobody answers, so try twice.
    if (registered) {
      const remove = () => deleteRunner(token, scope, jit.runnerId);
      await remove()
        .catch(remove)
        .catch((error) => logCleanup("delete runner", work, error));
    }
  }
}

function logCleanup(step: string, work: TakeoverWork, error: unknown) {
  log.warn("takeover.cleanup_failed", "takeover cleanup failed", {
    step,
    jobId: work.jobId,
    error,
  });
}
