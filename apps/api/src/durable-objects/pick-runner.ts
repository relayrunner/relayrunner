import { DurableObject } from "cloudflare:workers";
import { isAutoRelay, relayInputs } from "@relayrunner/runner-order";
import { autoPick, relayJobOf } from "../routing/auto-jobs.ts";
import type { Env } from "../env.ts";
import { runAttemptTriggeringActor, workflowJobStatus } from "../github/actions-api.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { createCheckRun } from "../github/repos-api.ts";
import { DEFAULT_RUNNER_GROUP_ID, deleteRunner, type RunnerScope } from "../github/runners-api.ts";
import { fetchOneGroupAccess, groupBlocksRepo } from "../github/github-runners.ts";
import { blockedReason, pickAccessCheckRun } from "../routing/pick-access.ts";
import { mintRepoFirst } from "../routing/repo-runner.ts";
import {
  type ClaimedJob,
  latestRunnerVersion,
  RunnerClient,
  decodeJitConfig,
  waitForJob,
} from "../routing/runner-protocol.ts";
import { RELAYRUNNER_LABEL } from "../routing/labels.ts";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import { recordPick, type PickRecord } from "../routing/route-decisions.ts";
import { evaluationRunner } from "../reports/evaluations.ts";
import { findInstallationAndWorkspace, installationRunnerScope } from "../github/installations.ts";
import { findRepo } from "../github/repositories.ts";
import { retryOf } from "../routing/retries.ts";
import { startedJobStatus } from "../ingest/jobs.ts";
import {
  type JobContext,
  jobContext,
  NO_RUNNER,
  noRunnerPage,
  type RouteDecision,
  sameLogin,
  type SkippedStep,
} from "../routing/routing.ts";
import {
  type FixLink,
  jobStepLogs,
  noRunnerLogs,
  type StepLog,
  uploadJobLogs,
} from "../reports/job-logs.ts";
import { jobSteps, nativeFreeCheck, nativeVerdict } from "../checks/native-checks.ts";
import { recordRepoCheck } from "../checks/free-checks.ts";
import { annotate, traced } from "../tracing.ts";
import { dashboardUrl } from "../email.ts";
import {
  clearNoRouteChecks,
  hadUnroutableAttempt,
  noRouteCheckRun,
  type RunAttempt,
  routeCheckTarget,
} from "../routing/route-check.ts";
import {
  afterAttempt,
  MAX_ATTEMPTS,
  RECHECK_AFTER_MS,
  pickRunnerName,
  RUN_STALE_MS,
  WAIT_FOR_JOB_MS,
} from "../routing/pick-attempts.ts";
import { log, withLogContext } from "../log.ts";

export interface PickWork {
  jobId: number;
  installationId: number;
  // owner/repo. An org install's runner registers in the owner org; a personal install's
  // registers on this repo (see runnerScope).
  repo: string;
}

// One per queued `pick` job, addressed by job id. Acts as a one-job runner: registers a JIT runner
// on the `relayrunner` label, claims a job, and reports the route as its `runner` output without
// running any steps. GitHub hands a runner any pending job with its label, so the job it claims
// may be another repo's in the same org. A personal account has no org runners, so its runner
// registers on the job's own repo and can only claim that repo's jobs. The route is for the
// claimed job's own repo and run.
// A claimed job whose steps are RelayRunner checks (src/checks/native-checks.ts) is answered here instead:
// the check runs in this object and the job completes as passed or failed, with no route.
//
// Because the runner can take another job, or time out, the job it was made for could be left with
// no runner at all. So when a runner is done, it asks GitHub whether its own job is still queued and,
// if so, starts a replacement (afterAttempt). A job GitHub will never offer it, because the Default
// runner group leaves the repo out (src/routing/pick-access.ts), gets no runner at all: the reason goes to
// Activity and to a failed check run on the commit, and the object stops trying. The 15-minute sweep (src/routing/pick-sweep.ts) catches runs a
// deploy cut off, and removes pick runners left registered on GitHub.
export class PickRunner extends DurableObject<Env> {
  // Idempotent: a redelivered or retried `queued` webhook for the same job does nothing.
  async start(work: PickWork): Promise<void> {
    if (await this.ctx.storage.get("started")) return;
    await this.ctx.storage.put({ started: true, work, attempt: 1 });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Whether a runner for this job is waiting to start or still running. */
  async active(): Promise<boolean> {
    if (await this.ctx.storage.get("work")) return true;
    const runningSince = await this.ctx.storage.get<number>("runningSince");
    return runningSince !== undefined && Date.now() - runningSince < RUN_STALE_MS;
  }

  /**
   * Starts another runner for a relay the sweep found still queued, unless one is already active or
   * the job has used its attempts. The runner checks the job is still queued before registering.
   */
  async rescue(work: PickWork): Promise<boolean> {
    if (await this.active()) return false;
    const attempt = ((await this.ctx.storage.get<number>("attempt")) ?? 1) + 1;
    if (attempt > MAX_ATTEMPTS) return false;
    await this.ctx.storage.put({ started: true, work, attempt });
    await this.ctx.storage.delete("runningSince");
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  async alarm() {
    const work = await this.ctx.storage.get<PickWork>("work");
    if (!work) return;
    const attempt = (await this.ctx.storage.get<number>("attempt")) ?? 1;
    await this.ctx.storage.delete("work");
    await this.ctx.storage.put("runningSince", Date.now());
    try {
      await withLogContext(
        {
          jobId: work.jobId,
          installationId: work.installationId,
          repo: work.repo,
          attempt,
        },
        () =>
          traced(
            "pick.run",
            {
              "github.job_id": work.jobId,
              "github.installation_id": work.installationId,
              "github.repository": work.repo,
              "relayrunner.pick.attempt": attempt,
            },
            () => this.run(work, attempt),
          ),
      );
    } finally {
      await this.ctx.storage.delete("runningSince");
    }
  }

  private async run(work: PickWork, attempt: number) {
    const startedAt = Date.now();
    let outcome: Record<string, unknown> = { result: "no-job" };
    let token: string | undefined;
    let scope: RunnerScope | undefined;
    let runnerId: number | undefined;
    let client: RunnerClient | undefined;
    try {
      [token, scope] = await Promise.all([
        appInstallationToken(this.env, work.installationId),
        installationRunnerScope(createDb(this.env.DB), work.installationId, work.repo),
      ]);
      // A replacement runner first makes sure its job still needs one.
      if (attempt > 1 && (await this.jobStatus(token, work)) !== "queued") {
        log.info("pick.not_needed", "pick not needed", {
          jobId: work.jobId,
          repo: work.repo,
          attempt,
        });
        return;
      }
      // The runner registers on the job's own repo, so no org runner group can keep the job from
      // it, and it can't take another repo's relay job. When GitHub refuses the repo, it falls
      // back to the org's Default group. A runner GitHub will never hand this job to would wait 4
      // minutes for nothing, so before that fallback the first runner checks the group allows the
      // repo, and says why when it doesn't.
      const minted = await mintRepoFirst(
        token,
        work.repo,
        { name: pickRunnerName(work.jobId, attempt), labels: [RELAYRUNNER_LABEL] },
        {
          fallbackScope: async () => scope!,
          log: {
            msg: "relayrunner pick runner registered on the org",
            jobId: work.jobId,
            installationId: work.installationId,
            attempt,
          },
          beforeFallback: async () => {
            if (attempt !== 1) return;
            const blocked = await blockedByRunnerGroup(this.env, token!, work).catch((error) => {
              logCleanupError("check runner group", work, error);
              return null;
            });
            if (blocked) throw new PickBlocked(blocked);
          },
        },
      ).catch(async (error) => {
        if (!(error instanceof PickBlocked)) throw error;
        // Nothing will come for the job: use up its attempts so the sweep doesn't rescue it.
        await this.ctx.storage.put("attempt", MAX_ATTEMPTS);
        log.warn("pick.blocked", "pick blocked", {
          jobId: work.jobId,
          repo: work.repo,
          attempt,
          reason: error.reason,
        });
        await reportBlocked(this.env, token!, work, error.reason);
        return null;
      });
      if (!minted) return;
      const { jit } = minted;
      scope = minted.scope;
      runnerId = jit.runnerId;

      client = new RunnerClient(decodeJitConfig(jit.encodedJitConfig), await latestRunnerVersion());
      await client.openSession();
      const request = await waitForJob(client, WAIT_FOR_JOB_MS);
      const job = request ? await client.claim(request) : null;
      if (job) {
        const startedAt = new Date();
        let lintLog: Record<string, unknown> | undefined;
        // What each step logged, for the job's step logs.
        let stepLines: string[] = [];
        const reports: { ok: boolean; lines: string[] }[] = [];
        const native = await nativeVerdict(job.message.steps, job.message.contextData, {
          // A lint step runs in its own LintRunner, one per job.
          // It reads the commit with the job's own token, which is passed along and never stored.
          lint: async (target, tools, paths) => {
            const {
              result,
              log: lint,
              lines,
            } = await this.env.LINT_RUNNER.getByName(`job:${work.jobId}`).lintJob(
              target,
              tools,
              paths,
              job.githubToken,
            );
            lintLog = lint;
            stepLines = lines ?? [];
            return result;
          },
          report: (step, result) => {
            reports[step] = {
              ok: result.ok,
              lines: [...stepLines, result.ok ? "Passed." : `##[error]${result.reason}`],
            };
            stepLines = [];
          },
        });
        if (native) {
          // A native check: answer it here instead of routing it. Nothing runs on a VM.
          const { result } = native;
          // The steps and their logs go up before the job completes, while its token still works.
          // A job without them is still answered, so a failure here is only logged.
          const logs = await sendJobLogs(
            job,
            jobStepLogs(
              jobSteps(job.message.steps),
              reports,
              result.ok ? undefined : result.reason,
            ),
            startedAt,
          );
          await client.complete(job, result.ok ? "succeeded" : "failed", {
            error: result.ok ? undefined : result.reason,
            annotations: result.annotations,
          });
          outcome = {
            result: result.ok ? "check_passed" : "check_failed",
            checks: native.checks,
            reason: result.ok ? undefined : result.reason,
            lint: lintLog,
            logs,
          };
          // For the Usage and Activity savings: the job never took an Actions runner. The job is
          // already answered, so a failure here only loses the count.
          const saving = nativeFreeCheck(native.checks, result.ok, job.message.contextData);
          if (saving)
            await recordRepoCheck(createDb(this.env.DB), saving.repository, saving.check).catch(
              (error) =>
                log.error("pick.check_saving_not_recorded", "native check saving not recorded", {
                  jobId: work.jobId,
                  error,
                }),
            );
        } else {
          const { record, ...pick } = await pickRunner(
            this.env,
            token,
            work.installationId,
            job.message.contextData,
            job.message.jobDisplayName,
          );
          // Fail fast without a runner: the job that needs the relay doesn't start. Its log and the
          // run's summary say why, since no step of its own ran to print anything.
          let fix: FixLink | undefined;
          let logs: string | undefined;
          if (pick.runner === null) {
            fix = fixPage(this.env, "skipped" in pick ? pick.skipped : []);
            const steps = noRunnerLogs(jobSteps(job.message.steps), pick.reason, fix);
            logs = await sendJobLogs(job, steps, startedAt);
          }
          await client.complete(
            job,
            pick.runner ? "succeeded" : "failed",
            pick.runner ? { outputs: { runner: pick.runner } } : { error: pick.reason },
          );
          outcome = { result: pick.runner ? "routed" : "no_runner", ...pick, logs };
          // The pull request's checks list says why too, and a re-run that routes clears it. It runs
          // after the pick is done, and a failure only loses the check.
          const target = routeCheckTarget(job.message.contextData);
          if (target)
            this.ctx.waitUntil(
              updateRouteCheck(this.env, token, target, pick.runner === null ? pick : null, {
                fix,
                repositoryId: record?.repositoryId ?? null,
              }).catch((error) => logCleanupError("route check", work, error)),
            );
          // For the Activity page. The relay is already answered, so a failure here only loses the
          // explanation.
          if (record)
            await recordPick(createDb(this.env.DB), {
              ...record,
              jobName: job.message.jobDisplayName || null,
              pickJobId: job.message.jobId || null,
            }).catch((error) =>
              log.error("pick.not_recorded", "pick not recorded", { jobId: work.jobId, error }),
            );
        }
        outcome = { ...outcome, claimedJob: job.message.jobDisplayName, runnerLabels: jit.labels };
        runnerId = undefined; // GitHub removes a JIT runner once its job is done.
      }
    } catch (error) {
      outcome = { result: "error", error: error instanceof Error ? error.message : String(error) };
    } finally {
      await client?.closeSession().catch((error) => logCleanupError("close session", work, error));
      // A runner left registered shows as idle on GitHub, and GitHub can hand it a job nobody will
      // take. Try twice; the sweep removes any that are still left.
      if (token && scope && runnerId !== undefined) {
        const id = runnerId;
        const at = scope;
        const remove = () => deleteRunner(token!, at, id);
        await remove()
          .catch(remove)
          .catch((error) => logCleanupError("delete runner", work, error));
      }
    }
    annotate({
      "relayrunner.pick.result": String(outcome.result),
      "relayrunner.runner": typeof outcome.runner === "string" ? outcome.runner : undefined,
    });
    // The pick's wide event: one per pick runner, with how it ended.
    (outcome.result === "error" ? log.error : log.info)("pick.finished", "pick finished", {
      ...outcome,
      durationMs: Date.now() - startedAt,
    });
    if (token) await this.rearmIfQueued(work, attempt, token);
  }

  // The job's status: from its webhooks once they say it started, else from GitHub.
  private async jobStatus(token: string, work: PickWork) {
    return (
      (await startedJobStatus(createDb(this.env.DB), work.jobId)) ??
      workflowJobStatus(token, work.repo, work.jobId)
    );
  }

  // The runner may have taken another job, or none: if its own job is still queued, nothing else
  // will come for it, so start a replacement. Usually the job's own webhook has already said it
  // started. When it hasn't, the replacement starts after RECHECK_AFTER_MS and checks again first,
  // by which time the webhook has usually arrived, so GitHub is rarely asked.
  private async rearmIfQueued(work: PickWork, attempt: number, token: string) {
    let status: string | null;
    try {
      // After the last attempt nothing checks again, so GitHub decides whether to give up.
      status =
        attempt >= MAX_ATTEMPTS
          ? await this.jobStatus(token, work)
          : await startedJobStatus(createDb(this.env.DB), work.jobId);
    } catch (error) {
      logCleanupError("check job status", work, error);
      return;
    }
    // Null before the last attempt: no webhook has said it started yet.
    const next =
      status === null && attempt < MAX_ATTEMPTS ? "rearm" : afterAttempt(status, attempt);
    if (next === "done") return;
    if (next === "give_up") {
      log.warn("pick.gave_up", "pick gave up", { jobId: work.jobId, repo: work.repo, attempt });
      return;
    }
    await this.ctx.storage.put({ work, attempt: attempt + 1 });
    await this.ctx.storage.setAlarm(Date.now() + RECHECK_AFTER_MS);
    log.info("pick.rearmed", "pick re-armed", {
      jobId: work.jobId,
      repo: work.repo,
      attempt: attempt + 1,
    });
  }
}

function logCleanupError(step: string, work: PickWork, error: unknown) {
  log.warn("pick.cleanup_failed", "pick cleanup failed", {
    step,
    jobId: work.jobId,
    repo: work.repo,
    error,
  });
}

type PickInfo = Omit<PickRecord, "jobName" | "pickJobId">;

// Where the claimed pick job's run goes. Only a repo of a workspace's installation reaches the
// workspace's Router, which walks the runner order. Anything we can't place gets no runner and a
// reason, and the relay fails. `record` is what the Activity page keeps (no workspace, no record).
async function pickRunner(
  env: Env,
  token: string,
  installationId: number,
  contextData: unknown,
  jobDisplayName?: string | null,
) {
  const parsed = jobContext(contextData);
  if (!parsed)
    return {
      runner: null,
      reason: `${NO_RUNNER}: RelayRunner couldn't read this job's repository and run.`,
    };
  const db = createDb(env.DB);
  // The GitHub lookup and the installation read don't depend on each other.
  let [context, { installation, workspaceId }] = await Promise.all([
    resolveTriggeredBy(token, parsed),
    findInstallationAndWorkspace(db, installationId),
  ]);
  if (!installation || !workspaceId)
    return {
      runner: null,
      reason: `${NO_RUNNER}: RelayRunner hasn't set up a workspace for this GitHub App installation yet.`,
      repo: context.repo,
    };
  // A suspended installation keeps its workspace but takes no jobs.
  if (installation.suspendedAt)
    return {
      runner: null,
      reason: `${NO_RUNNER}: this GitHub App installation is suspended.`,
      repo: context.repo,
    };
  const repo = await findRepo(db, installationId, context.repo);
  if (!repo) {
    const reason = `${NO_RUNNER}: RelayRunner doesn't have access to ${context.repo}.`;
    return {
      runner: null,
      reason,
      repo: context.repo,
      record: {
        workspaceId,
        repositoryId: null,
        context,
        decision: null,
        reason,
      } satisfies PickInfo,
    };
  }
  // An evaluation's run (src/reports/evaluations.ts) goes to the evaluated provider, whatever the runner
  // order says. It keeps no route decision, so it stays out of the Router's numbers and retries.
  const evaluation = await evaluationRunner(db, repo.id, context);
  if (evaluation) {
    log.info("pick.evaluation", "evaluation pick", {
      evaluationId: evaluation.evaluationId,
      repo: context.repo,
      runId: context.runId,
      runAttempt: context.runAttempt,
      label: evaluation.label,
    });
    return {
      runner: evaluation.label,
      step: evaluation.provider,
      skipped: [],
      notInOrder: [],
      repo: context.repo,
      runId: context.runId,
      runAttempt: context.runAttempt,
      private: repo.private,
      ...relayInputs(context),
    };
  }
  // An automatic retry's attempt is credited to the App, so it keeps the starter of the attempt it
  // retried, for Activity and for whose machines go first. "Only me" machines take it either way:
  // it's a re-run of a run their owner started.
  const retry = await retryOf(db, repo.id, context.runId, context.runAttempt);
  if (retry) context = { ...context, triggeredBy: retry.triggeredBy };
  // An auto relay's `auto` inputs become labels of the job's size, so the walk shows what it got.
  const auto = isAutoRelay(context)
    ? await autoPick(db, {
        workspaceId,
        repositoryId: repo.id,
        context,
        relayJob: relayJobOf(jobDisplayName),
      })
    : null;
  if (auto) context = { ...context, ...auto.inputs };
  const decision: RouteDecision = await env.ROUTER.getByName(workspaceId).route({
    workspaceId,
    installationId,
    repositoryId: repo.id,
    repo: context.repo,
    runId: context.runId,
    ...relayInputs(context),
    private: repo.private,
    startedBy: context.startedBy,
    triggeredBy: context.triggeredBy,
    runAttempt: context.runAttempt,
    retry,
    size: auto?.size,
    first: auto?.first,
  });
  return {
    ...decision,
    repo: context.repo,
    runId: context.runId,
    runAttempt: context.runAttempt,
    private: repo.private,
    ...relayInputs(context),
    record: {
      workspaceId,
      repositoryId: repo.id,
      context,
      decision,
      reason: decision.runner === null ? decision.reason : null,
    } satisfies PickInfo,
  };
}

/**
 * Fills in the id of a re-runner who isn't the run's actor: the `github` context names them only by
 * login. Costs one GitHub call, only on those re-runs. On a failure the id stays null, so the
 * attempt matches no member.
 */
async function resolveTriggeredBy(token: string, context: JobContext): Promise<JobContext> {
  const { triggeredBy } = context;
  if (!triggeredBy || triggeredBy.id !== null) return context;
  try {
    const actor = await runAttemptTriggeringActor(
      token,
      context.repo,
      context.runId,
      context.runAttempt,
    );
    if (actor && sameLogin(actor.login, triggeredBy.login))
      return { ...context, triggeredBy: actor };
  } catch (error) {
    log.warn("pick.actor_not_found", "pick triggering actor not found", {
      repo: context.repo,
      runId: context.runId,
      runAttempt: context.runAttempt,
      error,
    });
  }
  return context;
}

/** Stops the fallback to the org when its runner group would never deliver the job. */
class PickBlocked extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Why the org's Default runner group won't deliver this job to a pick runner, or null when it will.
 * A repo RelayRunner hasn't recorded is left to the claimed job's own checks.
 */
async function blockedByRunnerGroup(env: Env, token: string, work: PickWork) {
  const [repo, access] = await Promise.all([
    findRepo(createDb(env.DB), work.installationId, work.repo),
    fetchOneGroupAccess(token, work.repo.split("/")[0], DEFAULT_RUNNER_GROUP_ID),
  ]);
  const block = repo && groupBlocksRepo(access, repo);
  return block ? blockedReason(block, access, work.repo) : null;
}

/**
 * Puts a blocked relay's reason where people look: the Activity page (as a run that couldn't run)
 * and a failed check run on the commit. Either can fail without the other; both are only logged.
 */
async function reportBlocked(env: Env, token: string, work: PickWork, reason: string) {
  const db = createDb(env.DB);
  const [row] = await db
    .select({
      runId: schema.workflowJob.runId,
      runAttempt: schema.workflowJob.runAttempt,
      workflow: schema.workflowJob.workflowName,
      name: schema.workflowJob.name,
      headSha: schema.workflowJob.headSha,
      workspaceId: schema.workspace.id,
    })
    .from(schema.workflowJob)
    .innerJoin(
      schema.workspace,
      eq(schema.workspace.installationId, schema.workflowJob.installationId),
    )
    .where(eq(schema.workflowJob.id, work.jobId))
    .limit(1);
  if (!row) return;
  const runUrl = `https://github.com/${work.repo}/actions/runs/${row.runId}`;
  await Promise.all([
    row.workspaceId &&
      recordPick(db, {
        workspaceId: row.workspaceId,
        repositoryId: null,
        context: {
          repo: work.repo,
          runId: row.runId,
          runAttempt: row.runAttempt,
          workflow: row.workflow,
          workflowPath: null,
          ...relayInputs({}),
          startedBy: null,
          triggeredBy: null,
        },
        jobName: row.name,
        pickJobId: null,
        decision: null,
        reason: `${NO_RUNNER}: ${reason}`,
      }).catch((error) => logCleanupError("record blocked pick", work, error)),
    createCheckRun(token, work.repo, pickAccessCheckRun(row.headSha, runUrl, reason)).catch(
      (error) => logCleanupError("post blocked check run", work, error),
    ),
  ]);
}

/** Posts the failed route check, or clears an earlier attempt's once the run routes. */
async function updateRouteCheck(
  env: Env,
  token: string,
  run: RunAttempt,
  failed: { reason: string } | null,
  { fix, repositoryId }: { fix?: FixLink; repositoryId: number | null },
) {
  if (failed) await createCheckRun(token, run.repo, noRouteCheckRun(run, failed.reason, fix));
  else if (
    repositoryId !== null &&
    (await hadUnroutableAttempt(createDb(env.DB), { ...run, repositoryId }))
  )
    await clearNoRouteChecks(token, run);
}

/** The dashboard page that fixes a pick with no runner, or none when the walk didn't run. */
function fixPage(env: Env, skipped: SkippedStep[]): FixLink | undefined {
  if (!skipped.length) return undefined;
  const page = noRunnerPage(skipped);
  return { name: PAGE_NAMES[page], url: `${dashboardUrl(env)}/${page}` };
}

const PAGE_NAMES = { usage: "Usage", runners: "Runners", router: "Router" } as const;

// How long a job waits on its logs before it completes without them.
const JOB_LOGS_TIMEOUT_MS = 5_000;

// Sends a native job's steps and logs. Returns "sent", or why not, for the job's log line.
async function sendJobLogs(job: ClaimedJob, steps: StepLog[], startedAt: Date) {
  if (!job.resultsUrl) return "no results endpoint";
  if (steps.length === 0) return "no steps";
  try {
    await uploadJobLogs(
      {
        resultsUrl: job.resultsUrl,
        token: job.token,
        planId: job.message.plan.planId,
        jobId: job.message.jobId,
      },
      steps,
      { startedAt, completedAt: new Date() },
      AbortSignal.timeout(JOB_LOGS_TIMEOUT_MS),
    );
    return "sent";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
