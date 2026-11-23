// Provider evaluations: try a hosted provider on one of a workspace's workflows without touching
// its Router.
//
// 1. startEvaluation writes an `evaluation` row, then dispatches the workflow on the repo's default
//    branch with the App's Actions write permission. GitHub answers with the run's id, which the
//    row keeps.
// 2. Every relay job in that run asks the gateway where to go as usual; the pick
//    (evaluationRunner) sees the run is an evaluation's and answers the evaluation's label instead
//    of walking the runner order. The pick isn't kept as a route decision, so evaluation runs stay
//    out of the Router's numbers and automatic retries.
// 3. When an attempt finishes, advanceEvaluation re-runs every job of the run as the next attempt,
//    until it has `runs` of them. Every attempt runs the same commit, one after another: the first
//    shows a cold cache, the rest a warm one.
// 4. evaluationReport compares the attempts with the workflow's recent passing runs on the
//    default branch (the baseline), for the whole workflow and per job, split into waiting for a
//    runner and running.
//
// Workflows change only by hand: a workflow needs `workflow_dispatch` and relay jobs before it can
// be evaluated, and the dashboard shows what to add. An evaluation whose workflow lacks
// workflow_dispatch waits, and the next push that runs the workflow dispatches it again
// (resumeWaitingEvaluations).

import { billedMinutes, rateFor, runnerClass } from "./runner-rates.ts";
import { inWorkspace, PICK } from "./job-sql.ts";
import {
  HOSTED_PROVIDER_IDS,
  labelForSize,
  listRate,
  type HostedProviderId,
  type PriceBook,
  providerPlans,
  runnerSize,
} from "@relayrunner/providers";
import { AppError } from "@relayrunner/errors";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, desc, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  appInstallationToken,
  cancelRun,
  dispatchWorkflow,
  findDispatchedRun,
  repoDefaultBranch,
  rerunRun,
} from "./github-app.ts";
import { loadPriceBook } from "./prices.ts";
import { hostedRunner } from "./runner-waits.ts";
const DAY_MS = 24 * 60 * 60 * 1000;
import type { JobContext } from "./routing.ts";

const table = schema.evaluation;

type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;
const runs = schema.workflowRun;
const jobs = schema.jobTiming;

/** Attempts per evaluation: one cold, four warm. */
export const EVALUATION_RUNS = 5;
/** How far back the workflow list and the baseline look. */
export const BASELINE_DAYS = 14;
/** How many recent passing runs make the baseline. */
export const BASELINE_RUNS = 20;

// A label like RunsOn's carries the run id, which isn't known before the dispatch, and GitHub's own
// runners aren't something to evaluate against themselves.
export const EVALUABLE_PROVIDERS: readonly HostedProviderId[] = HOSTED_PROVIDER_IDS.filter(
  (id) => id !== "runs-on" && labelForSize(id, 2, 0) !== null,
);

export const isEvaluable = (provider: string): provider is HostedProviderId =>
  (EVALUABLE_PROVIDERS as readonly string[]).includes(provider);

type State = (typeof schema.evaluation.$inferSelect)["state"];
const ACTIVE: State[] = ["dispatching", "waiting", "running"];

// ---- Workflows to pick from ----------------------------------------------------------------------

export interface EvaluationWorkflow {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  /** The workflow's file, such as `.github/workflows/ci.yml`. */
  path: string;
  /** Runs in the last BASELINE_DAYS, first attempts only. */
  runs: number;
  /** Passing runs on the default branch in that time, which the baseline is made of. */
  baselineRuns: number;
  /** The median passing default-branch run, start to finish, or null with none. */
  medianMs: number | null;
  /** Whether any of its runs had a relay job, so an evaluation can steer its jobs. */
  relayed: boolean;
  /** Whether it was ever started with workflow_dispatch lately: then it surely can be. */
  dispatched: boolean;
}

/** The workspace's workflows that ran lately, busiest first. */
export async function evaluationWorkflows(
  db: Db,
  workspaceId: string,
  now = Date.now(),
): Promise<EvaluationWorkflow[]> {
  const since = now - BASELINE_DAYS * DAY_MS;
  const rows = await db.all<{
    repository_id: number;
    repository: string;
    workflow: string | null;
    path: string;
    runs: number;
    baseline_runs: number;
    dispatched: number;
    relayed: number;
  }>(sql`
    select ${runs.repositoryId} as repository_id, max(${runs.repositoryFullName}) as repository,
      max(${runs.workflowName}) as workflow, ${runs.workflowPath} as path,
      sum(${runs.runAttempt} = 1) as runs,
      sum(${runs.conclusion} = 'success' and ${runs.headBranch} = ${runs.defaultBranch}
        and ${runs.event} <> 'workflow_dispatch') as baseline_runs,
      max(${runs.event} = 'workflow_dispatch') as dispatched,
      max(exists (select 1 from ${jobs} where ${jobs.runId} = ${runs.id}
        and ${jobs.runAttempt} = ${runs.runAttempt} and ${PICK})) as relayed
    from ${runs}
    where ${inWorkspace(workspaceId, runs.installationId)} and ${runs.runStartedAt} >= ${since}
      and ${runs.workflowPath} is not null
    group by ${runs.repositoryId}, ${runs.workflowPath}`);
  const medians = await Promise.all(
    rows.map((row) =>
      baselineSpans(db, workspaceId, row.repository_id, row.path, now).then((spans) =>
        median(spans.map((span) => span.ms)),
      ),
    ),
  );
  return rows
    .map((row, i) => ({
      repositoryId: row.repository_id,
      repository: row.repository,
      workflow: row.workflow,
      path: row.path,
      runs: Number(row.runs),
      baselineRuns: Number(row.baseline_runs),
      medianMs: medians[i] ?? null,
      relayed: Boolean(row.relayed),
      dispatched: Boolean(row.dispatched),
    }))
    .sort((a, b) => b.runs - a.runs || a.path.localeCompare(b.path));
}

// ---- Starting and stopping -----------------------------------------------------------------------

export interface StartRequest {
  workspaceId: string;
  installationId: number;
  userId: string | null;
  repositoryId: number;
  workflowPath: string;
  provider: string;
  vcpus: number;
}

/**
 * Writes the evaluation, then dispatches its workflow. The row exists before GitHub can queue the
 * run, so the run's first relay job finds it (evaluationRunner waits for the run id briefly).
 */
export async function startEvaluation(env: Env, db: Db, request: StartRequest) {
  if (!isEvaluable(request.provider))
    throw new AppError("INVALID_REQUEST", { message: "That provider can't be evaluated." });
  const label = labelForSize(request.provider, request.vcpus, 0);
  if (!label) throw new AppError("INVALID_REQUEST", { message: "That size isn't offered." });
  const repo = await db
    .select({ fullName: schema.githubRepository.fullName })
    .from(schema.githubRepository)
    .where(
      and(
        eq(schema.githubRepository.id, request.repositoryId),
        eq(schema.githubRepository.installationId, request.installationId),
        isNull(schema.githubRepository.removedAt),
      ),
    )
    .get();
  if (!repo) throw new AppError("NOT_FOUND", { message: "RelayRunner can't see that repo." });
  const active = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.repositoryId, request.repositoryId),
        eq(table.workflowPath, request.workflowPath),
        inArray(table.state, ACTIVE),
      ),
    )
    .get();
  if (active) throw new AppError("EVALUATION_ACTIVE");

  const token = await appInstallationToken(env, request.installationId);
  const ref = await repoDefaultBranch(token, repo.fullName);
  const latestName = await db
    .select({ name: runs.workflowName })
    .from(runs)
    .where(
      and(eq(runs.repositoryId, request.repositoryId), eq(runs.workflowPath, request.workflowPath)),
    )
    .orderBy(desc(runs.githubUpdatedAt))
    .get();
  const id = crypto.randomUUID();
  await db.insert(table).values({
    id,
    workspaceId: request.workspaceId,
    installationId: request.installationId,
    repositoryId: request.repositoryId,
    repositoryFullName: repo.fullName,
    workflowPath: request.workflowPath,
    workflowName: latestName?.name ?? null,
    provider: request.provider,
    vcpus: request.vcpus,
    label,
    ref,
    runs: EVALUATION_RUNS,
    state: "dispatching",
    startedById: request.userId,
  });

  await dispatch(env, db, id);
  return id;
}

/** How long a waiting evaluation keeps looking for its workflow_dispatch trigger. */
const WAITING_MS = DAY_MS;

/**
 * Dispatches an evaluation's workflow and keeps its run id. A workflow without workflow_dispatch
 * leaves it waiting (no_dispatch) for someone to add the trigger; any other refusal fails it.
 */
export async function dispatch(env: Env, db: Db, id: string) {
  const row = await db.select().from(table).where(eq(table.id, id)).get();
  if (!row || (row.state !== "dispatching" && row.state !== "waiting")) return;
  await db.update(table).set({ state: "dispatching", error: null }).where(eq(table.id, id));
  const token = await appInstallationToken(env, row.installationId);
  const dispatchedAt = Date.now();
  const result = await dispatchWorkflow(token, row.repositoryFullName, row.workflowPath, row.ref);
  if (!result.ok) {
    if (result.status === 422 && /workflow_dispatch/i.test(result.message)) {
      await db
        .update(table)
        .set({ state: "waiting", error: "no_dispatch" })
        .where(eq(table.id, id));
      return;
    }
    await finish(db, id, "failed", result.message);
    throw new AppError("EVALUATION_NOT_STARTED");
  }
  const runId =
    result.runId ??
    (await findDispatchedRun(
      token,
      row.repositoryFullName,
      row.workflowPath,
      row.ref,
      dispatchedAt,
    ));
  if (!runId) {
    await finish(db, id, "failed", "GitHub didn't say which run it started.");
    throw new AppError("EVALUATION_NOT_STARTED");
  }
  await db.update(table).set({ runId, state: "running" }).where(eq(table.id, id));
}

/** Tries a waiting evaluation again, from the dashboard. */
export async function retryEvaluation(env: Env, db: Db, workspaceId: string, id: string) {
  const row = await db
    .select({ state: table.state })
    .from(table)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AppError("NOT_FOUND");
  if (row.state === "waiting") await dispatch(env, db, id);
}

/**
 * A push to a waiting evaluation's branch ran its workflow: the push may have added
 * workflow_dispatch, so dispatch again. Evaluations waiting longer than WAITING_MS give up.
 */
export async function resumeWaitingEvaluations(env: Env, db: Db, message: WorkflowRunMessage) {
  const { run, repository } = message;
  if (message.action !== "requested" || run.event !== "push" || !run.workflowPath) return;
  const waiting = await db
    .select({ id: table.id, ref: table.ref, createdAt: table.createdAt })
    .from(table)
    .where(
      and(
        eq(table.repositoryId, repository.id),
        eq(table.workflowPath, run.workflowPath),
        eq(table.state, "waiting"),
      ),
    );
  for (const row of waiting) {
    if (Date.now() - row.createdAt.getTime() > WAITING_MS) {
      await finish(db, row.id, "failed", "workflow_dispatch was never added.");
      continue;
    }
    if (row.ref === run.headBranch) await dispatch(env, db, row.id).catch(() => undefined);
  }
}

/** Stops an evaluation: no more attempts, and the one running is cancelled. */
export async function cancelEvaluation(env: Env, db: Db, workspaceId: string, id: string) {
  const row = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AppError("NOT_FOUND");
  if (!ACTIVE.includes(row.state)) return;
  await finish(db, id, "cancelled", null);
  if (row.runId) {
    const token = await appInstallationToken(env, row.installationId);
    const error = await cancelRun(token, row.repositoryFullName, row.runId);
    if (error) console.warn(JSON.stringify({ msg: "evaluation cancel failed", id, error }));
  }
}

function finish(db: Db, id: string, state: State, error: string | null) {
  return db
    .update(table)
    .set({ state, error, finishedAt: new Date() })
    .where(and(eq(table.id, id), inArray(table.state, ACTIVE)));
}

// ---- The pick ------------------------------------------------------------------------------------

// How long a relay job of a run our App dispatched waits for its evaluation's run id, and how often
// it looks. GitHub can queue the run's first job before its dispatch answer reaches us.
const RUN_ID_WAIT_MS = 10_000;
const RUN_ID_POLL_MS = 1_000;

export interface EvaluationPick {
  evaluationId: string;
  provider: HostedProviderId;
  label: string;
}

/**
 * The evaluation whose run this relay job belongs to, or null for any other run. Only a run an App
 * started with workflow_dispatch, while one of its workflow's evaluations is still waiting for its
 * run id, waits at all; every other job is answered at once.
 */
export async function evaluationRunner(
  db: Db,
  repositoryId: number,
  context: Pick<JobContext, "runId" | "workflowPath" | "startedBy">,
  { waitMs = RUN_ID_WAIT_MS, pollMs = RUN_ID_POLL_MS, sleep = defaultSleep } = {},
): Promise<EvaluationPick | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = await db
      .select({ id: table.id, provider: table.provider, label: table.label, state: table.state })
      .from(table)
      .where(and(eq(table.repositoryId, repositoryId), eq(table.runId, context.runId)))
      .get();
    if (row)
      return row.state === "running" && isEvaluable(row.provider)
        ? { evaluationId: row.id, provider: row.provider, label: row.label }
        : null;
    if (!startedByApp(context) || !context.workflowPath || Date.now() >= deadline) return null;
    const waiting = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.repositoryId, repositoryId),
          eq(table.workflowPath, context.workflowPath),
          eq(table.state, "dispatching"),
        ),
      )
      .get();
    if (!waiting) return null;
    await sleep(pollMs);
  }
}

const startedByApp = (context: Pick<JobContext, "startedBy">) =>
  context.startedBy?.login.endsWith("[bot]") ?? false;

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The next attempt ----------------------------------------------------------------------------

/**
 * On an evaluation run's `completed`: re-run it as the next attempt, or finish. Only the attempt
 * running now counts, and raising `attempt` claims the re-run, so a redelivered event can't start
 * a second one. A failed or cancelled attempt ends the evaluation.
 */
export async function advanceEvaluation(env: Env, db: Db, message: WorkflowRunMessage) {
  const { run, repository } = message;
  if (message.action !== "completed") return;
  const row = await db
    .select()
    .from(table)
    .where(and(eq(table.repositoryId, repository.id), eq(table.runId, run.id)))
    .get();
  if (!row || row.state !== "running" || row.attempt !== run.runAttempt) return;
  if (run.conclusion !== "success") {
    await finish(db, row.id, "failed", `Run ${run.runAttempt} ${run.conclusion ?? "ended"}.`);
    return;
  }
  if (run.runAttempt >= row.runs) {
    await finish(db, row.id, "done", null);
    return;
  }
  const claimed = await db
    .update(table)
    .set({ attempt: run.runAttempt + 1 })
    .where(and(eq(table.id, row.id), eq(table.attempt, run.runAttempt), eq(table.state, "running")))
    .returning({ id: table.id });
  if (claimed.length === 0) return;
  const token = await appInstallationToken(env, row.installationId);
  const error = await rerunRun(token, row.repositoryFullName, run.id);
  if (error)
    await finish(db, row.id, "failed", `GitHub didn't start run ${run.runAttempt + 1}: ${error}`);
}

// ---- The comparison ------------------------------------------------------------------------------

/** Where a job's time went, in ms: waiting for a runner, then running. */
export interface Split {
  waitMs: number;
  runMs: number;
}

export interface AttemptJob {
  name: string;
  status: "queued" | "running" | "done";
  conclusion: string | null;
  split: Split | null;
  /** Whether it ran on the evaluated provider: jobs without a relay keep their own runner. */
  onProvider: boolean;
}

export interface Attempt {
  attempt: number;
  status: "waiting" | "running" | "done";
  conclusion: string | null;
  /** First job queued to last job finished, once done. */
  ms: number | null;
  /** What the run cost at list prices once done (see runUsd), or null when a job has no price. */
  usd: number | null;
  jobs: AttemptJob[];
}

export interface JobComparison {
  name: string;
  baseline: Split | null;
  cold: Split | null;
  warm: Split | null;
  onProvider: boolean;
}

export interface EvaluationReport {
  id: string;
  state: State;
  error: string | null;
  provider: string;
  vcpus: number;
  label: string;
  repositoryId: number;
  repository: string;
  workflow: string | null;
  workflowPath: string;
  ref: string;
  runs: number;
  runId: number | null;
  createdAt: number;
  finishedAt: number | null;
  attempts: Attempt[];
  /** Medians of the baseline's runs; `usd` counts only runs whose every job has a price. */
  baseline: { runs: number; medianMs: number | null; waitMs: number | null; usd: number | null };
  /** The evaluation's medians: run 1, and runs 2 on. */
  cold: { ms: number | null; waitMs: number | null; usd: number | null };
  warm: { ms: number | null; waitMs: number | null; usd: number | null };
  jobs: JobComparison[];
}

type JobRow = Pick<
  typeof jobs.$inferSelect,
  | "name"
  | "labels"
  | "runnerGroupName"
  | "conclusion"
  | "queuedAt"
  | "startedAt"
  | "completedAt"
  | "runAttempt"
>;

const jobColumns = {
  name: jobs.name,
  labels: jobs.labels,
  runnerGroupName: jobs.runnerGroupName,
  conclusion: jobs.conclusion,
  queuedAt: jobs.queuedAt,
  startedAt: jobs.startedAt,
  completedAt: jobs.completedAt,
  runAttempt: jobs.runAttempt,
};

/** The workspace's recent evaluations, newest first, optionally of one provider. */
export async function listEvaluations(db: Db, workspaceId: string, provider?: string) {
  const rows = await db
    .select()
    .from(table)
    .where(
      provider
        ? and(eq(table.workspaceId, workspaceId), eq(table.provider, provider))
        : eq(table.workspaceId, workspaceId),
    )
    .orderBy(desc(table.createdAt))
    .limit(20);
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    provider: row.provider,
    repository: row.repositoryFullName,
    workflow: row.workflowName,
    workflowPath: row.workflowPath,
    attempt: row.attempt,
    runs: row.runs,
    createdAt: row.createdAt.getTime(),
  }));
}

export async function evaluationReport(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<EvaluationReport> {
  const row = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AppError("NOT_FOUND");

  const [ownJobs, baseline, book, repository] = await Promise.all([
    row.runId
      ? db
          .select(jobColumns)
          .from(jobs)
          .where(and(eq(jobs.repositoryId, row.repositoryId), eq(jobs.runId, row.runId)))
      : Promise.resolve([] as JobRow[]),
    baselineSpans(db, workspaceId, row.repositoryId, row.workflowPath, row.createdAt.getTime()),
    loadPriceBook(db),
    db
      .select({ private: schema.githubRepository.private })
      .from(schema.githubRepository)
      .where(eq(schema.githubRepository.id, row.repositoryId))
      .get(),
  ]);
  const usdOf = (rows: JobRow[]) => runUsd(book, rows, repository?.private);
  const real = (rows: JobRow[]) => rows.filter((job) => !isPick(job));
  const byAttempt = Map.groupBy(real(ownJobs), (job) => job.runAttempt);
  const providerJob = (job: JobRow) => job.labels.includes(row.label);

  const attempts: Attempt[] = Array.from({ length: row.runs }, (_, i) => {
    const attempt = i + 1;
    const attemptJobs = byAttempt.get(attempt) ?? [];
    const done =
      attemptJobs.length > 0 &&
      attemptJobs.every((job) => job.completedAt) &&
      (attempt < row.attempt || row.state !== "running");
    return {
      attempt,
      status: done ? "done" : attemptJobs.length > 0 ? "running" : "waiting",
      conclusion: done ? runConclusion(attemptJobs) : null,
      ms: done ? spanMs(attemptJobs) : null,
      usd: done ? usdOf(attemptJobs) : null,
      jobs: attemptJobs
        .map((job) => ({
          name: job.name,
          status: job.completedAt ? "done" : job.startedAt ? "running" : "queued",
          conclusion: job.conclusion,
          split: splitOf(job),
          onProvider: providerJob(job),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)) as AttemptJob[],
    };
  });

  const finished = attempts.filter((attempt) => attempt.status === "done");
  const cold = finished.filter((attempt) => attempt.attempt === 1);
  const warm = finished.filter((attempt) => attempt.attempt > 1);
  const ownSplits = (list: Attempt[], name: string) =>
    list.flatMap((attempt) =>
      attempt.jobs.flatMap((job) =>
        job.name === name && job.split && job.conclusion === "success" ? [job.split] : [],
      ),
    );

  const baselineJobs = Map.groupBy(
    baseline.flatMap((span) => span.jobs).filter((job) => job.conclusion === "success"),
    (job) => job.name,
  );
  const names = [
    ...new Set([
      ...attempts.flatMap((attempt) => attempt.jobs.map((job) => job.name)),
      ...baselineJobs.keys(),
    ]),
  ].sort();

  return {
    id: row.id,
    state: row.state,
    error: row.error,
    provider: row.provider,
    vcpus: row.vcpus,
    label: row.label,
    repositoryId: row.repositoryId,
    repository: row.repositoryFullName,
    workflow: row.workflowName,
    workflowPath: row.workflowPath,
    ref: row.ref,
    runs: row.runs,
    runId: row.runId,
    createdAt: row.createdAt.getTime(),
    finishedAt: row.finishedAt?.getTime() ?? null,
    attempts,
    baseline: {
      runs: baseline.length,
      medianMs: median(baseline.map((span) => span.ms)),
      waitMs: median(
        baseline.flatMap((span) => span.jobs.flatMap((job) => splitOf(job)?.waitMs ?? [])),
      ),
      usd: medianUsd(baseline.map((span) => usdOf(span.jobs))),
    },
    cold: summary(cold),
    warm: summary(warm),
    jobs: names.map((name) => ({
      name,
      baseline: medianSplit((baselineJobs.get(name) ?? []).flatMap((job) => splitOf(job) ?? [])),
      cold: medianSplit(ownSplits(cold, name)),
      warm: medianSplit(ownSplits(warm, name)),
      onProvider: attempts.some((attempt) =>
        attempt.jobs.some((job) => job.name === name && job.onProvider),
      ),
    })),
  };
}

function summary(attempts: Attempt[]) {
  return {
    ms: median(attempts.flatMap((attempt) => attempt.ms ?? [])),
    waitMs: median(
      attempts.flatMap((attempt) => attempt.jobs.flatMap((job) => job.split?.waitMs ?? [])),
    ),
    usd: medianUsd(attempts.map((attempt) => attempt.usd)),
  };
}

// ---- Cost ----------------------------------------------------------------------------------------

/**
 * What a run's jobs cost at list prices, in USD: each job's billed minutes (run time rounded up,
 * as GitHub bills) times its runner's per-minute price on the day it ran. GitHub's runners follow
 * the job-times rules (free in public repos, self-hosted runners and machines free); a hosted
 * provider's runner takes its list price, or its plan's 2 vCPU minute scaled by size when the price
 * list has none. Null when any job ran somewhere without a price. Free minutes, plan fees and
 * discounts aren't counted, so this is what a minute lists at, not what the bill says.
 */
export function runUsd(
  book: PriceBook,
  rows: JobRow[],
  isPrivate: boolean | null | undefined,
): number | null {
  let usd = 0;
  for (const job of rows) {
    if (!job.startedAt || !job.completedAt) continue;
    const at = job.completedAt.getTime();
    const minutes = billedMinutes(at - job.startedAt.getTime());
    const rate = jobRate(book, job, isPrivate, at);
    if (rate === null) return null;
    usd += minutes * rate;
  }
  return usd;
}

/** A job's runner's list price per minute on the day `at`, as runUsd prices it, or null. */
export function jobRate(
  book: PriceBook,
  job: Pick<JobRow, "labels" | "runnerGroupName">,
  isPrivate: boolean | null | undefined,
  at: number,
): number | null {
  const hosted = hostedRunner(job.labels, job.runnerGroupName);
  return hosted && hosted.provider !== "github"
    ? providerRate(book, hosted.provider, hosted.label.toLowerCase(), at)
    : rateFor(book, runnerClass(job.labels, job.runnerGroupName), isPrivate, at);
}

function providerRate(book: PriceBook, provider: string, label: string, at: number) {
  const listed = listRate(book, provider as HostedProviderId, label, at);
  if (listed !== null) return listed;
  const perMinute = providerPlans(provider)?.perMinute;
  const vcpus = runnerSize(provider, label)?.vcpus;
  return perMinute && vcpus ? (perMinute / 2) * vcpus : null;
}

function medianUsd(values: (number | null)[]): number | null {
  const known = values.filter((usd): usd is number => usd !== null);
  if (known.length === 0) return null;
  const sorted = known.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Span {
  ms: number;
  jobs: JobRow[];
}

/**
 * The workflow's last BASELINE_RUNS passing runs on its default branch over BASELINE_DAYS before
 * `before`, each as its jobs and their span (first queued to last finished). Dispatched runs are
 * left out, which leaves out every evaluation's.
 */
async function baselineSpans(
  db: Db,
  workspaceId: string,
  repositoryId: number,
  workflowPath: string,
  before: number,
): Promise<Span[]> {
  const recent = await db
    .select({ id: runs.id, runAttempt: runs.runAttempt })
    .from(runs)
    .where(
      and(
        inWorkspace(workspaceId, runs.installationId),
        eq(runs.repositoryId, repositoryId),
        eq(runs.workflowPath, workflowPath),
        eq(runs.conclusion, "success"),
        sql`${runs.headBranch} = ${runs.defaultBranch}`,
        notInArray(runs.event, ["workflow_dispatch"]),
        gte(runs.runStartedAt, new Date(before - BASELINE_DAYS * DAY_MS)),
        lt(runs.runStartedAt, new Date(before)),
      ),
    )
    .orderBy(desc(runs.runStartedAt))
    .limit(BASELINE_RUNS);
  if (recent.length === 0) return [];
  const rows = await db
    .select({ ...jobColumns, runId: jobs.runId })
    .from(jobs)
    .where(
      and(
        eq(jobs.repositoryId, repositoryId),
        inArray(
          jobs.runId,
          recent.map((run) => run.id),
        ),
      ),
    );
  const attemptOf = new Map(recent.map((run) => [run.id, run.runAttempt]));
  const byRun = Map.groupBy(
    rows.filter((job) => attemptOf.get(job.runId) === job.runAttempt),
    (job) => job.runId,
  );
  return recent.flatMap((run) => {
    const runJobs = byRun.get(run.id) ?? [];
    const ms = spanMs(runJobs);
    return ms === null ? [] : [{ ms, jobs: runJobs.filter((job) => !isPick(job)) }];
  });
}

const isPick = (job: Pick<JobRow, "labels">) =>
  job.labels.some((label) => label.toLowerCase() === "relayrunner");

function splitOf(job: JobRow): Split | null {
  if (!job.startedAt || !job.completedAt) return null;
  const queued = job.queuedAt ?? job.startedAt;
  return {
    waitMs: Math.max(0, job.startedAt.getTime() - queued.getTime()),
    runMs: Math.max(0, job.completedAt.getTime() - job.startedAt.getTime()),
  };
}

function spanMs(rows: JobRow[]): number | null {
  const starts = rows.flatMap((job) => (job.queuedAt ?? job.startedAt)?.getTime() ?? []);
  const ends = rows.flatMap((job) => job.completedAt?.getTime() ?? []);
  if (starts.length === 0 || ends.length === 0) return null;
  return Math.max(...ends) - Math.min(...starts);
}

function runConclusion(rows: JobRow[]) {
  const conclusions = rows.map((job) => job.conclusion);
  if (conclusions.some((c) => c === "failure" || c === "timed_out")) return "failure";
  if (conclusions.some((c) => c === "cancelled")) return "cancelled";
  return "success";
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function medianSplit(splits: Split[]): Split | null {
  if (splits.length === 0) return null;
  return {
    waitMs: median(splits.map((split) => split.waitMs))!,
    runMs: median(splits.map((split) => split.runMs))!,
  };
}
