import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { appInstallationToken, deleteOrgRunner, listOrgRunners } from "./github-app.ts";
import { pickJobIdFromRunnerName } from "./pick-attempts.ts";

// A relay queued this long with no taker is rescued; one older than a day GitHub has given up on.
export const STUCK_AFTER_MS = 5 * 60_000;
const STUCK_WINDOW_MS = 24 * 60 * 60_000;
const MAX_RESCUES = 50;

/**
 * Every 15 minutes, a backstop for relay jobs (src/durable-objects/pick-runner.ts):
 * - a relay still queued after STUCK_AFTER_MS gets another runner, in case a deploy cut its runner
 *   off before it could start a replacement;
 * - pick runners still registered on GitHub after their run ended are removed. GitHub shows them
 *   idle and can hand them a job that nothing will ever take.
 */
export async function sweepPicks(env: Env, now = Date.now()) {
  const results = await Promise.allSettled([
    rescueStuckRelays(env, now),
    removeLeftoverRunners(env),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function rescueStuckRelays(env: Env, now: number) {
  const db = createDb(env.DB);
  const stuck = await db
    .select({
      id: schema.workflowJob.id,
      installationId: schema.workflowJob.installationId,
      repo: schema.workflowJob.repositoryFullName,
    })
    .from(schema.workflowJob)
    .where(
      and(
        eq(schema.workflowJob.kind, "pick"),
        eq(schema.workflowJob.status, "queued"),
        lt(schema.workflowJob.githubCreatedAt, new Date(now - STUCK_AFTER_MS)),
        gt(schema.workflowJob.githubCreatedAt, new Date(now - STUCK_WINDOW_MS)),
      ),
    )
    .limit(MAX_RESCUES);
  for (const job of stuck) {
    const rescued = await env.PICK_RUNNER.getByName(String(job.id)).rescue({
      jobId: job.id,
      installationId: job.installationId,
      repo: job.repo,
    });
    if (rescued)
      console.log(
        JSON.stringify({ msg: "relayrunner pick rescued", jobId: job.id, repo: job.repo }),
      );
  }
}

async function removeLeftoverRunners(env: Env) {
  const installations = await createDb(env.DB)
    .select({ id: schema.githubInstallation.id, org: schema.githubInstallation.accountLogin })
    .from(schema.githubInstallation)
    .where(
      and(
        eq(schema.githubInstallation.accountType, "Organization"),
        isNull(schema.githubInstallation.suspendedAt),
      ),
    );
  for (const installation of installations) {
    try {
      const token = await appInstallationToken(env, installation.id);
      const runners = await listOrgRunners(token, installation.org);
      for (const runner of runners) {
        const jobId = pickJobIdFromRunnerName(runner.name);
        // Its object is active while it waits for or answers a job. Once the object is done, the
        // runner is a leftover even if GitHub calls it busy: a job GitHub gave it would never run.
        if (jobId === null) continue;
        if (await env.PICK_RUNNER.getByName(String(jobId)).active()) continue;
        await deleteOrgRunner(token, installation.org, runner.id);
        console.log(
          JSON.stringify({
            msg: "relayrunner pick runner removed",
            org: installation.org,
            runner: runner.name,
            status: runner.status,
            busy: runner.busy,
          }),
        );
      }
    } catch (error) {
      // One org failing (the App lost access, say) shouldn't stop the others.
      console.warn(
        JSON.stringify({
          msg: "relayrunner pick sweep failed",
          installationId: installation.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
