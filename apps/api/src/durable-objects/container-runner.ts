import { DurableObject } from "cloudflare:workers";
import {
  CONTAINER_LABEL,
  containerLabels,
  containerRunnerGroupId,
  MAX_LIFETIME_MS,
  WATCH_INTERVAL_MS,
  watchStep,
  type RunnerState,
} from "../container-runner.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../webhook-queue.ts";
import type { PickWork } from "./pick-runner.ts";
import {
  appInstallationToken,
  DEFAULT_RUNNER_GROUP_ID,
  deleteRunner,
  generateJitConfig,
  listOrgRunnerGroups,
  runnerBusy,
  runnerScope,
  type RunnerScope,
} from "../github-app.ts";
import { createDb } from "../db/index.ts";
import { installationRunnerScope } from "../installations.ts";

// The same work a pick gets: the job id, its installation, and owner/repo (the org the runner
// registers in, or the repo itself for a personal account).
export type ContainerWork = PickWork;

interface Launched extends ContainerWork {
  runnerId: number;
  startedAt: number;
  // Where the runner registered. Missing on containers launched before personal accounts: org.
  scope?: RunnerScope;
}

// The smallest size GitHub's runner fits in: ½ vCPU, 4 GiB. `lite` (256 MiB) is too small for the
// runner and a job's tools.
const INSTANCE = "standard-1";
// Installation tokens last an hour. One is reused across checks for a bit less than that.
const TOKEN_REUSE_MS = 50 * 60_000;

// One per queued `runs-on: relayrunner-container` job, addressed by job id. Mints a one-job JIT
// runner on that label and boots a container that runs it (container/Dockerfile). GitHub hands
// the runner any queued job with the label in the org, which is fine: every such job gets its own
// container. An alarm checks on the container every minute, stops one that never got a job or ran
// too long, and deletes the runner if it's still registered.
export class ContainerRunner extends DurableObject<Env> {
  // The installation token, kept in memory while the object is awake.
  private cachedToken?: { value: string; at: number };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The inactivity timeout doesn't survive a restart (a deploy), so set it again.
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(MAX_LIFETIME_MS));
  }

  // Idempotent: a redelivered or retried `queued` webhook for the same job does nothing.
  async start(work: ContainerWork): Promise<void> {
    if (await this.ctx.storage.get("started")) return;
    await this.ctx.storage.put({ started: true, work });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const launched = await this.ctx.storage.get<Launched>("launched");
    if (launched) return this.watch(launched);
    const work = await this.ctx.storage.get<ContainerWork>("work");
    if (work) await this.launch(work);
  }

  private async launch(work: ContainerWork) {
    const container = this.ctx.container;
    const startedAt = Date.now();
    await this.ctx.storage.delete("work");
    if (!container) return log("error", work, { error: "no container is configured" });
    try {
      const token = await this.token(work.installationId);
      const scope = await installationRunnerScope(
        createDb(this.env.DB),
        work.installationId,
        work.repo,
      );
      const jit = await generateJitConfig(token, scope, {
        name: `relayrunner-container-${work.jobId}`,
        labels: [CONTAINER_LABEL],
        // Only an org has runner groups to pick from.
        runnerGroupId:
          scope.kind === "org"
            ? containerRunnerGroupId(
                await listOrgRunnerGroups(token, scope.org),
                DEFAULT_RUNNER_GROUP_ID,
              )
            : undefined,
      });
      try {
        container.start({
          image: container.images.runner,
          instance: INSTANCE,
          enableInternet: true,
          env: { RUNNER_JIT_CONFIG: jit.encodedJitConfig },
          labels: containerLabels(work),
        });
        await container.setInactivityTimeout(MAX_LIFETIME_MS);
        // Logs how the container ends while the object is awake (up to 15 minutes); the alarm
        // covers the rest.
        this.ctx.waitUntil(
          container.monitor().then(
            () => log("exited", work, { lifetimeMs: Date.now() - startedAt }),
            (error) =>
              log("error", work, {
                error: `container stopped: ${errorMessage(error)}`,
                lifetimeMs: Date.now() - startedAt,
              }),
          ),
        );
      } catch (error) {
        await deleteRunner(token, scope, jit.runnerId).catch(() => undefined);
        throw error;
      }
      const state: Launched = { ...work, runnerId: jit.runnerId, startedAt, scope };
      await this.ctx.storage.put("launched", state);
      await this.ctx.storage.setAlarm(Date.now() + WATCH_INTERVAL_MS);
      log("started", work, { runnerId: jit.runnerId, launchMs: Date.now() - startedAt });
    } catch (error) {
      log("error", work, { error: errorMessage(error) });
    }
  }

  private async token(installationId: number) {
    const now = Date.now();
    if (!this.cachedToken || now - this.cachedToken.at > TOKEN_REUSE_MS)
      this.cachedToken = { value: await appInstallationToken(this.env, installationId), at: now };
    return this.cachedToken.value;
  }

  private async watch(launched: Launched) {
    const container = this.ctx.container;
    const scope = launched.scope ?? runnerScope("Organization", launched.repo);
    const now = Date.now();
    const lifetimeMs = now - launched.startedAt;
    const running = container?.running ?? false;
    let token: string | undefined;
    let runner: RunnerState = "idle";
    try {
      token = await this.token(launched.installationId);
      // An exited container needs no status, only the runner's cleanup.
      if (running) {
        const busy = await runnerBusy(token, scope, launched.runnerId);
        runner = busy === null ? "gone" : busy ? "busy" : "idle";
      }
    } catch (error) {
      // GitHub unreachable: keep the container until the lifetime limit.
      log("status unavailable", launched, { error: errorMessage(error) });
    }
    const step = watchStep({
      running,
      runner,
      startedAt: launched.startedAt,
      now,
    });
    if (step === "wait") {
      await this.ctx.storage.setAlarm(now + WATCH_INTERVAL_MS);
      return;
    }
    if (step !== "done") await container?.destroy(step).catch(() => undefined);
    if (token && runner !== "gone")
      await deleteRunner(token, scope, launched.runnerId).catch(() => undefined);
    // `started` stays, so a late redelivery of the `queued` webhook doesn't launch again.
    await this.ctx.storage.delete("launched");
    log("finished", launched, { result: step, runner, lifetimeMs });
  }
}

function log(event: string, work: ContainerWork, fields: Record<string, unknown>) {
  const write =
    event === "error" ? console.error : event === "status unavailable" ? console.warn : console.log;
  write(
    JSON.stringify({
      msg: `relayrunner container ${event}`,
      jobId: work.jobId,
      repo: work.repo,
      installationId: work.installationId,
      ...fields,
    }),
  );
}
