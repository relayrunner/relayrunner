import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { createDb, type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { appInstallationToken, deleteRunner, listRunners, type RunnerScope } from "./github-app.ts";
import { enqueueInstallationTasks } from "./installation-tasks.ts";
import { pickJobIdFromRunnerName } from "./pick-attempts.ts";
import { errorMessage } from "./webhook-queue.ts";

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
    removeLeftoverRunners(env, now),
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

/**
 * Where pick runners can be left: each repo that had a relay in the last day, since pick runners
 * register on the job's own repo (listing every repo would cost a call per repo), and each org
 * with an active installation, for the ones that fell back to the org.
 */
export async function sweepTargets(
  db: Db,
  now: number,
): Promise<{ installationId: number; scope: RunnerScope }[]> {
  const [orgs, repos] = await Promise.all([
    db
      .select({ id: schema.githubInstallation.id, org: schema.githubInstallation.accountLogin })
      .from(schema.githubInstallation)
      .where(
        and(
          eq(schema.githubInstallation.accountType, "Organization"),
          isNull(schema.githubInstallation.suspendedAt),
        ),
      ),
    db
      .selectDistinct({
        id: schema.workflowJob.installationId,
        repo: schema.workflowJob.repositoryFullName,
      })
      .from(schema.workflowJob)
      .innerJoin(
        schema.githubInstallation,
        eq(schema.githubInstallation.id, schema.workflowJob.installationId),
      )
      .where(
        and(
          isNull(schema.githubInstallation.suspendedAt),
          eq(schema.workflowJob.kind, "pick"),
          gt(schema.workflowJob.githubCreatedAt, new Date(now - STUCK_WINDOW_MS)),
        ),
      ),
  ]);
  return [
    ...orgs.map((row) => ({
      installationId: row.id,
      scope: { kind: "org", org: row.org } as const,
    })),
    ...repos.map((row) => ({
      installationId: row.id,
      scope: { kind: "repo", repo: row.repo } as const,
    })),
  ];
}

// Queues one sweep per installation (src/installation-tasks.ts), covering its org and repos, so
// installations are swept side by side however many there are.
async function removeLeftoverRunners(env: Env, now: number) {
  const scopes = new Map<number, RunnerScope[]>();
  for (const { installationId, scope } of await sweepTargets(createDb(env.DB), now))
    scopes.set(installationId, [...(scopes.get(installationId) ?? []), scope]);
  await enqueueInstallationTasks(
    env,
    [...scopes].map(([installationId, list]) => ({
      kind: "pick-sweep",
      installationId,
      scopes: list,
    })),
  );
}

/** Removes the pick runners left registered in an installation's org or repos once their object is done. */
export async function removeLeftoverRunnersIn(
  env: Env,
  installationId: number,
  scopes: RunnerScope[],
): Promise<void> {
  for (const scope of scopes) {
    const where = scope.kind === "org" ? { org: scope.org } : { repo: scope.repo };
    try {
      const token = await appInstallationToken(env, installationId);
      const runners = await listRunners(token, scope);
      for (const runner of runners) {
        const jobId = pickJobIdFromRunnerName(runner.name);
        // Its object is active while it waits for or answers a job. Once the object is done, the
        // runner is a leftover even if GitHub calls it busy: a job GitHub gave it would never run.
        if (jobId === null) continue;
        if (await env.PICK_RUNNER.getByName(String(jobId)).active()) continue;
        await deleteRunner(token, scope, runner.id);
        console.log(
          JSON.stringify({
            msg: "relayrunner pick runner removed",
            ...where,
            runner: runner.name,
            status: runner.status,
            busy: runner.busy,
          }),
        );
      }
    } catch (error) {
      // One org or repo failing (the App lost access, say) shouldn't stop the others.
      console.warn(
        JSON.stringify({
          msg: "relayrunner pick sweep failed",
          installationId,
          ...where,
          error: errorMessage(error),
        }),
      );
    }
  }
}
