// A new installation's recent workflow runs, read from GitHub. RelayRunner otherwise only knows the
// runs whose webhooks it received, so a workspace made a minute ago has nothing to evaluate a
// provider against (src/reports/evaluations.ts lists workflows and builds baselines from workflow_run and
// job_timing). Installing the App queues one import (src/ingest/webhook-queue.ts), which the installation
// task queue runs (src/github/installation-tasks.ts):
//
// - Every finished run of the last BASELINE_DAYS in each repo the App sees, up to a few pages a
//   repo, into workflow_run.
// - The jobs of the runs a baseline is made of (each workflow's latest passing runs on the default
//   branch, not dispatched), into job_timing, so the evaluation has job times to compare with.
//
// Rows a webhook already wrote are left alone, and imported jobs don't count toward the usage
// rollups: they finished before the App was installed. Meanwhile the workflow list adds the
// workflows GitHub lists (withGitHubWorkflows), so nobody waits on it: the dashboard shows a note
// while it runs (GET /api/evaluations/history), and an evaluation started meanwhile starts at once,
// since its comparison reads the baseline only when shown.
//
// GitHub cost: one runs page per 100 runs (at most MAX_PAGES a repo, MAX_REPOS repos), one call for
// each repo's default branch, and one jobs call per baseline run, at most MAX_JOB_READS in all.
import { toWebhookMessage, type WebhookMessage } from "@relayrunner/github-webhooks";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { attemptJobs, recentRuns, repoWorkflows } from "../github/actions-api.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { enqueueInstallationTasks } from "../github/installation-queue.ts";
import { repoDefaultBranch } from "../github/repos-api.ts";
import { BASELINE_DAYS, BASELINE_RUNS, type EvaluationWorkflow } from "../reports/evaluations.ts";
import { workflowRunValues } from "../reports/runs.ts";
import { DAY_MS } from "../time.ts";
import { jobTimingValues } from "./job-timings.ts";

const table = schema.runHistoryImport;

export const MAX_REPOS = 30;
export const MAX_PAGES = 3;
export const MAX_JOB_READS = 200;
/** Rows per D1 batch. */
const WRITE_BATCH = 50;
/** Jobs calls at once. */
const JOB_READS_AT_ONCE = 6;

export type RunHistoryState = "queued" | "running" | "done" | "failed";

type RunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;
type JobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;

/** Queues the import for a new installation, once. */
export async function queueRunHistory(env: Env, db: Db, installationId: number) {
  const [queued] = await db
    .insert(table)
    .values({ installationId, state: "queued" })
    .onConflictDoNothing()
    .returning({ installationId: table.installationId });
  if (queued) await enqueueInstallationTasks(env, [{ kind: "run-history", installationId }]);
}

/** Where an installation's import is, or null when it never had one (installed before imports). */
export async function runHistoryState(db: Db, installationId: number) {
  const row = await db
    .select({ state: table.state, runs: table.runs })
    .from(table)
    .where(eq(table.installationId, installationId))
    .get();
  return row ? { state: row.state as RunHistoryState, runs: row.runs } : null;
}

const setState = (db: Db, installationId: number, values: Partial<typeof table.$inferInsert>) =>
  db
    .update(table)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(table.installationId, installationId));

/** Whether an import is still going. */
export const importing = (history: { state: RunHistoryState } | null) =>
  history?.state === "queued" || history?.state === "running";

/** Runs the import. A failure is recorded rather than thrown: the workflow list then shows what it has. */
export async function importRunHistory(env: Env, installationId: number, now = Date.now()) {
  const db = createDb(env.DB);
  await setState(db, installationId, { state: "running", error: null });
  try {
    const runs = await importRuns(env, db, installationId, now);
    await setState(db, installationId, { state: "done", runs, finishedAt: new Date() });
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "run history import failed",
        installationId,
        error: errorMessage(error),
      }),
    );
    await setState(db, installationId, {
      state: "failed",
      error: errorMessage(error).slice(0, 500),
      finishedAt: new Date(),
    });
  }
}

/**
 * While the import runs, the workflow list adds the workflows GitHub lists that no imported run
 * named yet, so someone can pick one before the history is in. They have no runs or times, and
 * whether they go through a relay isn't known until their runs are.
 */
export async function withGitHubWorkflows(
  env: Env,
  db: Db,
  installationId: number,
  known: EvaluationWorkflow[],
): Promise<EvaluationWorkflow[]> {
  const repos = await db
    .select({ id: schema.githubRepository.id, fullName: schema.githubRepository.fullName })
    .from(schema.githubRepository)
    .where(
      and(
        eq(schema.githubRepository.installationId, installationId),
        isNull(schema.githubRepository.removedAt),
      ),
    )
    .orderBy(desc(schema.githubRepository.updatedAt))
    .limit(MAX_REPOS);
  const token = await appInstallationToken(env, installationId);
  const listed = await Promise.all(
    repos.map((repo) =>
      repoWorkflows(token, repo.fullName).then(
        (workflows) => workflows.map((workflow) => ({ repo, workflow })),
        () => [],
      ),
    ),
  );
  const seen = new Set(known.map((w) => `${w.repositoryId}:${w.path}`));
  const added = listed
    .flat()
    .filter(
      ({ repo, workflow }) =>
        workflow.state === "active" &&
        workflow.path.startsWith(".github/workflows/") &&
        !seen.has(`${repo.id}:${workflow.path}`),
    )
    .map(({ repo, workflow }): EvaluationWorkflow => ({
      repositoryId: repo.id,
      repository: repo.fullName,
      workflow: workflow.name,
      path: workflow.path,
      runs: 0,
      baselineRuns: 0,
      medianMs: null,
      relayed: null,
      dispatched: false,
    }));
  return [...known.map((w) => ({ ...w, relayed: w.relayed || null })), ...added];
}

async function importRuns(env: Env, db: Db, installationId: number, now: number) {
  const repos = await db
    .select({ id: schema.githubRepository.id, fullName: schema.githubRepository.fullName })
    .from(schema.githubRepository)
    .where(
      and(
        eq(schema.githubRepository.installationId, installationId),
        isNull(schema.githubRepository.removedAt),
      ),
    )
    .orderBy(desc(schema.githubRepository.updatedAt))
    .limit(MAX_REPOS);
  const token = await appInstallationToken(env, installationId);
  const sinceDay = new Date(now - BASELINE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const receivedAt = new Date(now).toISOString();
  let written = 0;
  let jobReads = MAX_JOB_READS;

  for (const repo of repos) {
    const raw: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await recentRuns(token, repo.fullName, sinceDay, page);
      raw.push(...batch);
      if (batch.length < 100) break;
    }
    if (raw.length === 0) continue;
    const defaultBranch = await repoDefaultBranch(token, repo.fullName);
    const repository = { id: repo.id, full_name: repo.fullName, default_branch: defaultBranch };
    const runs = raw.flatMap((run) => {
      const message = toWebhookMessage(
        "workflow_run",
        "history",
        {
          action: "completed",
          installation: { id: installationId },
          repository,
          workflow_run: run,
        },
        receivedAt,
      ) as RunMessage | null;
      return message ? [message] : [];
    });
    await writeInBatches(
      db,
      runs.map((message) =>
        db
          .insert(schema.workflowRun)
          .values({
            id: message.run.id,
            runAttempt: message.run.runAttempt,
            ...workflowRunValues(message),
          })
          .onConflictDoNothing(),
      ),
    );
    written += runs.length;

    const wanted = baselineRuns(runs).slice(0, jobReads);
    jobReads -= wanted.length;
    const jobs: JobMessage[] = [];
    for (let i = 0; i < wanted.length; i += JOB_READS_AT_ONCE) {
      const read = await Promise.all(
        wanted
          .slice(i, i + JOB_READS_AT_ONCE)
          .map((run) => attemptJobs(token, repo.fullName, run.id, run.runAttempt)),
      );
      for (const job of read.flat()) {
        const message = toWebhookMessage(
          "workflow_job",
          "history",
          {
            action: "completed",
            installation: { id: installationId },
            repository,
            workflow_job: job,
          },
          receivedAt,
        ) as JobMessage | null;
        if (message) jobs.push(message);
      }
    }
    await writeInBatches(
      db,
      jobs.map((message) =>
        db
          .insert(schema.jobTiming)
          .values(jobTimingValues(installationId, message.repository, message.job).values)
          .onConflictDoNothing(),
      ),
    );
    await setState(db, installationId, { runs: written });
  }
  return written;
}

/** The runs each workflow's baseline is made of: its latest passing, non-dispatched runs on the default branch. */
export function baselineRuns(runs: RunMessage[]) {
  const byWorkflow = Map.groupBy(
    runs
      .map((message) => message.run)
      .filter(
        (run) =>
          run.workflowPath &&
          run.conclusion === "success" &&
          run.headBranch === run.defaultBranch &&
          run.event !== "workflow_dispatch",
      )
      .sort((a, b) => Date.parse(b.runStartedAt ?? "") - Date.parse(a.runStartedAt ?? "")),
    (run) => run.workflowPath,
  );
  return [...byWorkflow.values()].flatMap((each) => each.slice(0, BASELINE_RUNS));
}

async function writeInBatches(db: Db, statements: { run: () => unknown }[]) {
  for (let i = 0; i < statements.length; i += WRITE_BATCH) {
    const chunk = statements.slice(i, i + WRITE_BATCH);
    if (chunk.length) await db.batch(chunk as unknown as Parameters<Db["batch"]>[0]);
  }
}

// For tests: the import's row as stored.
export const runHistoryRow = (db: Db, installationId: number) =>
  db.select().from(table).where(eq(table.installationId, installationId)).get();
