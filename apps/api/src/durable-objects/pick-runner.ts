import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import {
  appJwt,
  DEFAULT_RUNNER_GROUP_ID,
  deleteOrgRunner,
  generateOrgJitConfig,
  importAppPrivateKey,
  installationToken,
} from "../github-app.ts";
import { latestRunnerVersion, RunnerClient, decodeJitConfig } from "../runner-protocol.ts";
import { RELAYRUNNER_LABEL } from "../webhook-queue.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import { recordPick, type PickRecord } from "../route-decisions.ts";
import { jobContext, NO_RUNNER, type RouteDecision } from "../routing.ts";
import { nativeVerdict } from "../native-checks.ts";

export interface PickWork {
  jobId: number;
  installationId: number;
  // owner/repo. The owner is the org the runner registers in.
  repo: string;
}

const POLL_TIMEOUT_MS = 60_000;
const WAIT_FOR_JOB_MS = 4 * 60_000;

// One per queued `pick` job, addressed by job id. Acts as a one-job runner: registers a JIT runner
// on the `relayrunner` label, claims a job, and reports the route as its `runner` output without
// running any steps. GitHub hands a runner any pending job with its label, so the job it claims
// may be another repo's in the same org. The route is for the claimed job's own repo and run.
// A claimed job whose steps are RelayRunner checks (src/native-checks.ts) is answered here instead:
// the check runs in this object and the job completes as passed or failed, with no route.
export class PickRunner extends DurableObject<Env> {
  // Idempotent: a redelivered or retried `queued` webhook for the same job does nothing.
  async start(work: PickWork): Promise<void> {
    if (await this.ctx.storage.get("started")) return;
    await this.ctx.storage.put({ started: true, work });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const work = await this.ctx.storage.get<PickWork>("work");
    if (!work) return;
    await this.ctx.storage.delete("work");

    const org = work.repo.split("/")[0];
    const startedAt = Date.now();
    let outcome: Record<string, unknown> = { result: "no-job" };
    let token: string | undefined;
    let runnerId: number | undefined;
    let client: RunnerClient | undefined;
    try {
      const key = await importAppPrivateKey(await this.env.GITHUB_APP_PRIVATE_KEY.get());
      token = await installationToken(
        await appJwt(this.env.GITHUB_APP_ID, key),
        work.installationId,
      );
      const jit = await generateOrgJitConfig(token, org, {
        name: `relayrunner-pick-${work.jobId}`,
        labels: [RELAYRUNNER_LABEL],
        runnerGroupId: DEFAULT_RUNNER_GROUP_ID,
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
      await client?.closeSession().catch(() => undefined);
      if (token && runnerId !== undefined)
        await deleteOrgRunner(token, org, runnerId).catch(() => undefined);
    }
    const log = outcome.result === "error" ? console.error : console.log;
    log(
      JSON.stringify({
        msg: "relayrunner pick finished",
        jobId: work.jobId,
        repo: work.repo,
        installationId: work.installationId,
        ...outcome,
        durationMs: Date.now() - startedAt,
      }),
    );
  }
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
  const [repo] = await db
    .select({ id: schema.githubRepository.id, private: schema.githubRepository.private })
    .from(schema.githubRepository)
    .where(
      and(
        eq(schema.githubRepository.installationId, installationId),
        sql`lower(${schema.githubRepository.fullName}) = ${context.repo.toLowerCase()}`,
        isNull(schema.githubRepository.removedAt),
      ),
    )
    .limit(1);
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
