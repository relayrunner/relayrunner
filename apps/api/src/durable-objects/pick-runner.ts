import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import {
  appJwt,
  createCheckRun,
  DEFAULT_RUNNER_GROUP_ID,
  deleteRunner,
  generateJitConfig,
  importAppPrivateKey,
  type RunnerScope,
  installationToken,
  workflowJobStatus,
} from "../github-app.ts";
import { fetchOneGroupAccess, groupBlocksRepo } from "../github-runners.ts";
import { blockedReason, pickAccessCheckRun } from "../pick-access.ts";
import { latestRunnerVersion, RunnerClient, decodeJitConfig } from "../runner-protocol.ts";
import { RELAYRUNNER_LABEL } from "../webhook-queue.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import { recordPick, type PickRecord } from "../route-decisions.ts";
import { installationRunnerScope } from "../installations.ts";
import { jobContext, NO_RUNNER, type RouteDecision } from "../routing.ts";
import { nativeFreeCheck, nativeVerdict } from "../native-checks.ts";
import { recordRepoCheck } from "../free-checks.ts";
import {
  afterAttempt,
  MAX_ATTEMPTS,
  pickRunnerName,
  RUN_STALE_MS,
  WAIT_FOR_JOB_MS,
} from "../pick-attempts.ts";

export interface PickWork {
  jobId: number;
  installationId: number;
  // owner/repo. An org install's runner registers in the owner org; a personal install's
  // registers on this repo (see runnerScope).
  repo: string;
}

const POLL_TIMEOUT_MS = 60_000;
// One per queued `pick` job, addressed by job id. Acts as a one-job runner: registers a JIT runner
// on the `relayrunner` label, claims a job, and reports the route as its `runner` output without
// running any steps. GitHub hands a runner any pending job with its label, so the job it claims
// may be another repo's in the same org. A personal account has no org runners, so its runner
// registers on the job's own repo and can only claim that repo's jobs. The route is for the
// claimed job's own repo and run.
// A claimed job whose steps are RelayRunner checks (src/native-checks.ts) is answered here instead:
// the check runs in this object and the job completes as passed or failed, with no route.
//
// Because the runner can take another job, or time out, the job it was made for could be left with
// no runner at all. So when a runner is done, it asks GitHub whether its own job is still queued and,
// if so, starts a replacement (afterAttempt). A job GitHub will never offer it, because the Default
// runner group leaves the repo out (src/pick-access.ts), gets no runner at all: the reason goes to
// Activity and to a failed check run on the commit, and the object stops trying. The 15-minute sweep (src/pick-sweep.ts) catches runs a
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
      await this.run(work, attempt);
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
      const key = await importAppPrivateKey(await this.env.GITHUB_APP_PRIVATE_KEY.get());
      token = await installationToken(
        await appJwt(this.env.GITHUB_APP_ID, key),
        work.installationId,
      );
      scope = await installationRunnerScope(createDb(this.env.DB), work.installationId, work.repo);
      // A replacement runner first makes sure its job still needs one.
      if (attempt > 1 && (await workflowJobStatus(token, work.repo, work.jobId)) !== "queued") {
        console.log(
          JSON.stringify({
            msg: "relayrunner pick not needed",
            jobId: work.jobId,
            repo: work.repo,
            attempt,
          }),
        );
        return;
      }
      // A runner GitHub will never hand this job to would wait 4 minutes for nothing, or take
      // another repo's job and leave this one queued. The group rarely changes, so only the first
      // runner checks. A repo runner has no groups, so there's nothing to check.
      const blocked =
        attempt === 1 && scope.kind === "org"
          ? await blockedByRunnerGroup(this.env, token, work).catch((error) => {
              logCleanupError("check runner group", work, error);
              return null;
            })
          : null;
      if (blocked) {
        // Nothing will come for the job: use up its attempts so the sweep doesn't rescue it.
        await this.ctx.storage.put("attempt", MAX_ATTEMPTS);
        console.warn(
          JSON.stringify({
            msg: "relayrunner pick blocked",
            jobId: work.jobId,
            repo: work.repo,
            attempt,
            reason: blocked,
          }),
        );
        await reportBlocked(this.env, token, work, blocked);
        return;
      }
      const jit = await generateJitConfig(token, scope, {
        name: pickRunnerName(work.jobId, attempt),
        labels: [RELAYRUNNER_LABEL],
      });
      runnerId = jit.runnerId;

      client = new RunnerClient(decodeJitConfig(jit.encodedJitConfig), await latestRunnerVersion());
      await client.openSession();
      const request = await waitForJob(client);
      const job = request ? await client.claim(request) : null;
      if (job) {
        const native = await nativeVerdict(job.message.steps, job.message.contextData, {
          // A lint step runs in its own LintRunner, one per job.
          lint: (target, tools, paths) =>
            this.env.LINT_RUNNER.getByName(`job:${work.jobId}`).lintJob(target, tools, paths),
        });
        if (native) {
          // A native check: answer it here instead of routing it. Nothing runs on a VM.
          const { result } = native;
          await client.complete(job, result.ok ? "succeeded" : "failed", {
            error: result.ok ? undefined : result.reason,
          });
          outcome = {
            result: result.ok ? "check_passed" : "check_failed",
            checks: native.checks,
            reason: result.ok ? undefined : result.reason,
          };
          // For the Usage and Activity savings: the job never took an Actions runner. The job is
          // already answered, so a failure here only loses the count.
          const saving = nativeFreeCheck(native.checks, result.ok, job.message.contextData);
          if (saving)
            await recordRepoCheck(createDb(this.env.DB), saving.repository, saving.check).catch(
              (error) =>
                console.error(
                  JSON.stringify({
                    msg: "relayrunner native check saving not recorded",
                    jobId: work.jobId,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                ),
            );
        } else {
          const { record, ...pick } = await pickRunner(
            this.env,
            work.installationId,
            job.message.contextData,
          );
          // Fail fast without a runner: the job that needs the relay doesn't start.
          await client.complete(
            job,
            pick.runner ? "succeeded" : "failed",
            pick.runner ? { outputs: { runner: pick.runner } } : { error: pick.reason },
          );
          outcome = { result: pick.runner ? "routed" : "no_runner", ...pick };
          // For the Activity page. The relay is already answered, so a failure here only loses the
          // explanation.
          if (record)
            await recordPick(createDb(this.env.DB), {
              ...record,
              jobName: job.message.jobDisplayName || null,
            }).catch((error) =>
              console.error(
                JSON.stringify({
                  msg: "relayrunner pick not recorded",
                  jobId: work.jobId,
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
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
    const log = outcome.result === "error" ? console.error : console.log;
    log(
      JSON.stringify({
        msg: "relayrunner pick finished",
        jobId: work.jobId,
        repo: work.repo,
        installationId: work.installationId,
        attempt,
        ...outcome,
        durationMs: Date.now() - startedAt,
      }),
    );
    if (token) await this.rearmIfQueued(work, attempt, token);
  }

  // The runner may have taken another job, or none: if its own job is still queued, nothing else
  // will come for it, so start a replacement.
  private async rearmIfQueued(work: PickWork, attempt: number, token: string) {
    let status: string | null;
    try {
      status = await workflowJobStatus(token, work.repo, work.jobId);
    } catch (error) {
      logCleanupError("check job status", work, error);
      return;
    }
    const next = afterAttempt(status, attempt);
    if (next === "done") return;
    if (next === "give_up") {
      console.warn(
        JSON.stringify({
          msg: "relayrunner pick gave up",
          jobId: work.jobId,
          repo: work.repo,
          attempt,
        }),
      );
      return;
    }
    await this.ctx.storage.put({ work, attempt: attempt + 1 });
    await this.ctx.storage.setAlarm(Date.now());
    console.log(
      JSON.stringify({
        msg: "relayrunner pick re-armed",
        jobId: work.jobId,
        repo: work.repo,
        attempt: attempt + 1,
      }),
    );
  }
}

function logCleanupError(step: string, work: PickWork, error: unknown) {
  console.warn(
    JSON.stringify({
      msg: "relayrunner pick cleanup failed",
      step,
      jobId: work.jobId,
      repo: work.repo,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function waitForJob(client: RunnerClient) {
  const deadline = Date.now() + WAIT_FOR_JOB_MS;
  while (Date.now() < deadline) {
    try {
      const request = await client.poll(AbortSignal.timeout(POLL_TIMEOUT_MS));
      if (request) return request;
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
    }
  }
  return null;
}

type PickInfo = Omit<PickRecord, "jobName">;

// Where the claimed pick job's run goes. Only a repo of a workspace's installation reaches the
// workspace's Router, which walks the runner order. Anything we can't place gets no runner and a
// reason, and the relay fails. `record` is what the Activity page keeps (no workspace, no record).
async function pickRunner(env: Env, installationId: number, contextData: unknown) {
  const context = jobContext(contextData);
  if (!context)
    return {
      runner: null,
      reason: `${NO_RUNNER}: RelayRunner couldn't read this job's repository and run.`,
    };
  const db = createDb(env.DB);
  const [installation] = await db
    .select({ workspaceId: schema.githubInstallation.workspaceId })
    .from(schema.githubInstallation)
    .where(eq(schema.githubInstallation.id, installationId))
    .limit(1);
  if (!installation?.workspaceId)
    return {
      runner: null,
      reason: `${NO_RUNNER}: this GitHub App installation isn't connected to a RelayRunner workspace.`,
      repo: context.repo,
    };
  const workspaceId = installation.workspaceId;
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
  const decision: RouteDecision = await env.ROUTER.getByName(workspaceId).route({
    workspaceId,
    installationId,
    repositoryId: repo.id,
    repo: context.repo,
    runId: context.runId,
    machine: context.machine,
    github: context.github,
    blacksmith: context.blacksmith,
    private: repo.private,
  });
  return {
    ...decision,
    repo: context.repo,
    runId: context.runId,
    runAttempt: context.runAttempt,
    private: repo.private,
    machine: context.machine,
    github: context.github,
    blacksmith: context.blacksmith,
    record: {
      workspaceId,
      repositoryId: repo.id,
      context,
      decision,
      reason: decision.runner === null ? decision.reason : null,
    } satisfies PickInfo,
  };
}

// A repo the installation can still see, by owner/name in any case, or undefined.
async function findRepo(db: Db, installationId: number, fullName: string) {
  const [repo] = await db
    .select({ id: schema.githubRepository.id, private: schema.githubRepository.private })
    .from(schema.githubRepository)
    .where(
      and(
        eq(schema.githubRepository.installationId, installationId),
        sql`lower(${schema.githubRepository.fullName}) = ${fullName.toLowerCase()}`,
        isNull(schema.githubRepository.removedAt),
      ),
    )
    .limit(1);
  return repo;
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
      workspaceId: schema.githubInstallation.workspaceId,
    })
    .from(schema.workflowJob)
    .innerJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workflowJob.installationId),
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
          machine: [],
          github: [],
          blacksmith: [],
        },
        jobName: row.name,
        decision: null,
        reason: `${NO_RUNNER}: ${reason}`,
      }).catch((error) => logCleanupError("record blocked pick", work, error)),
    createCheckRun(token, work.repo, pickAccessCheckRun(row.headSha, runUrl, reason)).catch(
      (error) => logCleanupError("post blocked check run", work, error),
    ),
  ]);
}
