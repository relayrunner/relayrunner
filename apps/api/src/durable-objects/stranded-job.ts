import { DurableObject } from "cloudflare:workers";
import { createDb } from "../db/index.ts";
import type { Env } from "../env.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { deleteRunner } from "../github/runners-api.ts";
import { installationRunnerScope } from "../github/installations.ts";
import { mintRepoFirst } from "../routing/repo-runner.ts";
import { routeLabel } from "../routing/routing.ts";
import {
  decodeJitConfig,
  latestRunnerVersion,
  RunnerClient,
  waitForJob,
} from "../routing/runner-protocol.ts";
import {
  jobStillQueued,
  STRANDED_MESSAGES,
  strandedRunnerName,
  type StrandedReason,
} from "../routing/stranded-jobs.ts";
import { traced } from "../tracing.ts";
import { errorMessage } from "../errors.ts";

export interface StrandedWork {
  routeId: string;
  jobId: number;
  installationId: number;
  repo: string;
  reason: StrandedReason;
}

// How long the runner waits for GitHub to offer it the job.
const WAIT_FOR_JOB_MS = 2 * 60_000;

// One per route whose job no machine can take (src/routing/stranded-jobs.ts), addressed by route id. Acts
// as a one-job runner on the route's label: claims the job and fails it with the reason, so the
// run finishes now instead of sitting queued for 24 hours, and automatic retries can pick again.
export class StrandedJob extends DurableObject<Env> {
  // Idempotent: the job is only ended once. True when this call started it.
  async start(work: StrandedWork): Promise<boolean> {
    if (await this.ctx.storage.get("started")) return false;
    await this.ctx.storage.put({ started: true, work });
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  async alarm() {
    const work = await this.ctx.storage.get<StrandedWork>("work");
    if (!work) return;
    await this.ctx.storage.delete("work");
    let result: string;
    try {
      result = await traced(
        "stranded.end",
        {
          "relayrunner.route_id": work.routeId,
          "github.job_id": work.jobId,
          "github.repository": work.repo,
        },
        () => endJob(this.env, work),
      );
    } catch (error) {
      result = "error";
      console.error(
        JSON.stringify({
          msg: "relayrunner stranded job not ended",
          ...work,
          error: errorMessage(error),
        }),
      );
    }
    console.log(JSON.stringify({ msg: "relayrunner stranded job", ...work, result }));
  }
}

async function endJob(env: Env, work: StrandedWork) {
  const db = createDb(env.DB);
  const token = await appInstallationToken(env, work.installationId);
  if (!(await jobStillQueued(db, async () => token, work.repo, work.jobId))) return "not_queued";
  const [{ jit, scope }, version] = await Promise.all([
    mintRepoFirst(
      token,
      work.repo,
      { name: strandedRunnerName(work.routeId), labels: [routeLabel(work.routeId)] },
      {
        fallbackScope: () => installationRunnerScope(db, work.installationId, work.repo),
        log: { msg: "relayrunner stranded runner registered on the org", ...work },
      },
    ),
    latestRunnerVersion(),
  ]);
  // GitHub removes a JIT runner once its job is done; until then, this one is ours to remove.
  let registered = true;
  const client = new RunnerClient(decodeJitConfig(jit.encodedJitConfig), version);
  try {
    await client.openSession();
    const request = await waitForJob(client, WAIT_FOR_JOB_MS);
    if (!request) return "no_job";
    const job = await client.claim(request);
    registered = false;
    await client.complete(job, "failed", { error: STRANDED_MESSAGES[work.reason] });
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

function logCleanup(step: string, work: StrandedWork, error: unknown) {
  console.warn(
    JSON.stringify({
      msg: "relayrunner stranded cleanup failed",
      step,
      routeId: work.routeId,
      error: errorMessage(error),
    }),
  );
}
