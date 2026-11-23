// Comparing runners on a workflow from the runs it already had: routed jobs, GitHub's own and
// provider evaluations, with no new runs. Two reads:
//
// - workflowCosts, for the Performance page's Workflows tab: each workflow's median cost per run,
//   the runners it ran on, the fastest of them against GitHub, and its time and spend in total.
// - workflowReport, for one workflow's page: every successful run (the chart) and each runner's
//   whole-run and per-job medians (the Runners table), plus providers it could be evaluated on.
//
// Costs are list prices, priced like an evaluation's results (runUsd): billed minutes times the
// runner's per-minute price, free in public repos and on machines and self-hosted runners.
//
// Database cost: workflowCosts is one range of job_timing_installation_idx over the window, grouped
// by run and runner, so a row per run and runner rather than per job. workflowReport is a range of
// job_timing_job_idx (repository, workflow) over the window, capped at JOB_LIMIT rows.
import { environmentFor, environmentProvider, nameMachines } from "./environments.ts";
import { billedMinutes } from "./runner-rates.ts";
import { inWorkspace, matrixName, RAN, BILLED_MINUTES } from "./job-sql.ts";
import { HOSTED_PROVIDER_IDS } from "@relayrunner/providers";
import type {
  FastestRunner,
  WorkflowCost,
  WorkflowJobStat,
  WorkflowReport,
  WorkflowRunner,
  WorkflowRunPoint,
} from "@relayrunner/api-types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import { EVALUABLE_PROVIDERS, jobRate, median } from "./evaluations.ts";
import { type Environment, FEW_RUNS } from "./job-times.ts";
import { loadPriceBook } from "../providers/prices.ts";
import { type Window, windowDays } from "./report-window.ts";

const timing = schema.jobTiming;

/** ubuntu-latest: the runner most people know, so the one others are measured against. */
export const BASELINE = "github:linux-2-core";

/** Most job rows one workflow page reads, newest first. */
export const JOB_LIMIT = 5000;

// D1 allows 100 bound parameters a statement.
const CHUNK = 90;

/** Whether each repository is private, by id. Unknown repos are left out (priced as private). */
async function repoPrivacy(db: Db, ids: number[]) {
  const privacy = new Map<number, boolean>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({ id: schema.githubRepository.id, private: schema.githubRepository.private })
      .from(schema.githubRepository)
      .where(inArray(schema.githubRepository.id, ids.slice(i, i + CHUNK)));
    for (const row of rows) privacy.set(row.id, row.private);
  }
  return privacy;
}

const key = (repositoryId: number, workflow: string | null) =>
  `${repositoryId}\u001f${workflow ?? ""}`;

interface RunPart {
  repository_id: number;
  run_id: number;
  run_attempt: number;
  workflow_name: string | null;
  labels: string;
  runner_group_name: string | null;
  machine_id: string | null;
  jobs: number;
  ok: number;
  billed: number;
  run_ms: number;
  first_queued: number;
  last_completed: number;
}

/** Each run's jobs in the window, a row per runner they ran on. */
function runPartsQuery(workspaceId: string, { from, to }: Window) {
  return sql`
    select ${timing.repositoryId} as repository_id, ${timing.runId} as run_id,
      ${timing.runAttempt} as run_attempt, min(${timing.workflowName}) as workflow_name,
      ${timing.labels} as labels, ${timing.runnerGroupName} as runner_group_name,
      ${timing.machineId} as machine_id, count(*) as jobs,
      sum(coalesce(${timing.conclusion} = 'success', 0)) as ok,
      sum(${BILLED_MINUTES}) as billed,
      sum(${timing.completedAt} - ${timing.startedAt}) as run_ms,
      min(coalesce(${timing.queuedAt}, ${timing.startedAt})) as first_queued,
      max(${timing.completedAt}) as last_completed
    from ${timing}
    where ${inWorkspace(workspaceId)} and ${timing.completedAt} >= ${from}
      and ${timing.completedAt} < ${to} and ${RAN}
    group by ${timing.repositoryId}, ${timing.runId}, ${timing.runAttempt}, ${timing.labels},
      ${timing.runnerGroupName}, ${timing.machineId}`;
}

interface WholeRun {
  workflow: string;
  runMs: number;
  /** Its priced jobs' cost. */
  spentUsd: number;
  ok: boolean;
  ms: number;
  usd: number | null;
  /** Its one runner, or null when its jobs ran in more than one place. */
  environment: string | null;
  environments: Set<string>;
}

/**
 * Which runner beat GitHub by the most on whole runs, each runner's median over FEW_RUNS+ runs
 * that ran every job there. Null when GitHub's runner or no other has enough runs.
 */
export function fastestRunner(runs: { ms: number; environment: string | null }[]) {
  const byEnv = Map.groupBy(
    runs.filter((run) => run.environment !== null),
    (run) => run.environment!,
  );
  const medianOf = (env: string) => {
    const list = byEnv.get(env) ?? [];
    return list.length >= FEW_RUNS ? median(list.map((run) => run.ms)) : null;
  };
  const base = medianOf(BASELINE);
  if (!base) return null;
  let fastest: FastestRunner | null = null;
  for (const env of byEnv.keys()) {
    if (env === BASELINE) continue;
    const ms = medianOf(env);
    if (ms === null) continue;
    const ratio = ms / base;
    if (!fastest || ratio < fastest.ratio) fastest = { environment: env, ratio };
  }
  return fastest;
}

function medianUsd(values: (number | null)[]) {
  const known = values.filter((usd): usd is number => usd !== null);
  if (known.length === 0) return null;
  const sorted = known.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Each workflow's cost per run, runners, fastest runner and totals in the window, by workflowKey. */
export async function workflowCosts(
  db: Db,
  workspaceId: string,
  window: Window,
): Promise<Map<string, WorkflowCost>> {
  const [parts, book] = await Promise.all([
    db.all<RunPart>(runPartsQuery(workspaceId, window)),
    loadPriceBook(db),
  ]);
  const privacy = await repoPrivacy(db, [...new Set(parts.map((part) => part.repository_id))]);

  const runs = new Map<string, WholeRun & { first: number; last: number; runMs: number }>();
  for (const part of parts) {
    const labels = JSON.parse(part.labels) as string[];
    const env = environmentFor(labels, part.runner_group_name, part.machine_id).key;
    const rate = jobRate(
      book,
      { labels, runnerGroupName: part.runner_group_name },
      privacy.get(part.repository_id),
      Number(part.last_completed),
    );
    const usd = rate === null ? null : Number(part.billed) * rate;

    const id = `${part.repository_id}:${part.run_id}:${part.run_attempt}`;
    const run = runs.get(id);
    const ok = Number(part.ok) === Number(part.jobs);
    if (!run) {
      runs.set(id, {
        workflow: key(part.repository_id, part.workflow_name),
        ok,
        ms: 0,
        usd,
        environment: env,
        environments: new Set([env]),
        first: Number(part.first_queued),
        last: Number(part.last_completed),
        runMs: Number(part.run_ms),
        spentUsd: usd ?? 0,
      });
      continue;
    }
    run.runMs += Number(part.run_ms);
    run.spentUsd += usd ?? 0;
    run.ok &&= ok;
    run.usd = run.usd === null || usd === null ? null : run.usd + usd;
    if (run.environment !== env) run.environment = null;
    run.environments.add(env);
    run.first = Math.min(run.first, Number(part.first_queued));
    run.last = Math.max(run.last, Number(part.last_completed));
  }

  const byWorkflow = Map.groupBy(runs.values(), (run) => run.workflow);
  const workflows = new Map<string, WorkflowCost>();
  for (const [workflow, list] of byWorkflow) {
    for (const run of list) run.ms = Math.max(0, run.last - run.first);
    const passed = list.filter((run) => run.ok);
    const counts = new Map<string, number>();
    for (const run of list)
      for (const env of run.environments) counts.set(env, (counts.get(env) ?? 0) + 1);
    workflows.set(workflow, {
      usd: medianUsd(passed.map((run) => run.usd)),
      environments: [...counts].sort((a, b) => b[1] - a[1]).map(([env]) => env),
      fastest: fastestRunner(passed),
      runMs: list.reduce((sum, run) => sum + run.runMs, 0),
      spentUsd: list.reduce((sum, run) => sum + run.spentUsd, 0),
    });
  }
  return workflows;
}

// ---- One workflow --------------------------------------------------------------------------------

export interface WorkflowQuery {
  repositoryId: number;
  workflow: string | null;
}

const jobColumns = {
  repository: timing.repositoryFullName,
  runId: timing.runId,
  runAttempt: timing.runAttempt,
  name: timing.name,
  labels: timing.labels,
  runnerGroupName: timing.runnerGroupName,
  machineId: timing.machineId,
  conclusion: timing.conclusion,
  queuedAt: timing.queuedAt,
  startedAt: timing.startedAt,
  completedAt: timing.completedAt,
};

/** Null when the workspace has no runs of the workflow in the window. */
export async function workflowReport(
  db: Db,
  workspaceId: string,
  { repositoryId, workflow }: WorkflowQuery,
  window: Window,
): Promise<WorkflowReport | null> {
  const [rows, book, repository, evaluations] = await Promise.all([
    db
      .select(jobColumns)
      .from(timing)
      .where(
        and(
          eq(timing.repositoryId, repositoryId),
          workflow === null
            ? sql`${timing.workflowName} is null`
            : eq(timing.workflowName, workflow),
          sql`${timing.completedAt} >= ${window.from} and ${timing.completedAt} < ${window.to}`,
          inWorkspace(workspaceId),
          RAN,
        ),
      )
      .orderBy(sql`${timing.completedAt} desc`)
      .limit(JOB_LIMIT + 1),
    loadPriceBook(db),
    db
      .select({ private: schema.githubRepository.private })
      .from(schema.githubRepository)
      .where(eq(schema.githubRepository.id, repositoryId))
      .get(),
    db
      .select({ runId: schema.evaluation.runId })
      .from(schema.evaluation)
      .where(
        and(
          eq(schema.evaluation.workspaceId, workspaceId),
          eq(schema.evaluation.repositoryId, repositoryId),
        ),
      ),
  ]);
  if (rows.length === 0) return null;
  const truncated = rows.length > JOB_LIMIT;
  const jobs = truncated ? rows.slice(0, JOB_LIMIT) : rows;
  const evaluated = new Set(evaluations.map((row) => row.runId));

  const envs = new Map<string, Environment>();
  const priced = jobs.map((job) => {
    const env = environmentFor(job.labels, job.runnerGroupName, job.machineId);
    if (!envs.has(env.key)) envs.set(env.key, env);
    const at = job.completedAt!.getTime();
    const ms = Math.max(0, at - job.startedAt!.getTime());
    const rate = jobRate(book, job, repository?.private, at);
    return {
      ...job,
      // Matrix legs read as one job: the longest leg's time, every leg's cost.
      group: matrixName(job.name) ?? job.name,
      environment: env.key,
      ms,
      waitMs: job.queuedAt ? Math.max(0, job.startedAt!.getTime() - job.queuedAt.getTime()) : null,
      usd: rate === null ? null : billedMinutes(ms) * rate,
    };
  });
  await nameMachines(db, workspaceId, envs);

  type Job = (typeof priced)[number];
  const runs = [...Map.groupBy(priced, (job) => `${job.runId}:${job.runAttempt}`).values()];
  const points: WorkflowRunPoint[] = [];
  const touched = new Map<string, { runs: number; evaluations: number }>();
  for (const runJobs of runs) {
    const { runId, runAttempt } = runJobs[0]!;
    const evaluation = evaluated.has(runId);
    for (const env of new Set(runJobs.map((job) => job.environment))) {
      const count = touched.get(env) ?? { runs: 0, evaluations: 0 };
      if (evaluation) count.evaluations += 1;
      else count.runs += 1;
      touched.set(env, count);
    }
    if (!runJobs.every((job) => job.conclusion === "success")) continue;
    const first = Math.min(...runJobs.map((job) => (job.queuedAt ?? job.startedAt)!.getTime()));
    const last = Math.max(...runJobs.map((job) => job.completedAt!.getTime()));
    const environments = new Set(runJobs.map((job) => job.environment));
    const groups = Map.groupBy(runJobs, (job) => `${job.group}\u001f${job.environment}`);
    points.push({
      runId,
      runAttempt,
      at: last,
      ms: Math.max(0, last - first),
      usd: sumUsd(runJobs),
      environment: environments.size === 1 ? [...environments][0]! : null,
      evaluation,
      jobs: [...groups.values()].map((legs) => ({
        name: legs[0]!.group,
        environment: legs[0]!.environment,
        ms: Math.max(...legs.map((job) => job.ms)),
        // The longest-waiting leg, like the longest-running one.
        waitMs: legs.some((job) => job.waitMs !== null)
          ? Math.max(...legs.map((job) => job.waitMs ?? 0))
          : null,
        usd: sumUsd(legs),
      })),
    });
  }
  points.sort((a, b) => a.at - b.at);

  // Job names, most run first.
  const jobRuns = new Map<string, number>();
  for (const job of priced) jobRuns.set(job.group, (jobRuns.get(job.group) ?? 0) + 1);
  const names = [...jobRuns].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const runners: WorkflowRunner[] = [...envs.values()].map((env) => {
    const whole = points.filter((point) => point.environment === env.key);
    const byJob = Map.groupBy(
      points.flatMap((point) => point.jobs.filter((job) => job.environment === env.key)),
      (job) => job.name,
    );
    const jobStats: Record<string, WorkflowJobStat> = {};
    for (const [name, list] of byJob)
      jobStats[name] = {
        runs: list.length,
        medianMs: median(list.map((job) => job.ms)),
        usd: medianUsd(list.map((job) => job.usd)),
      };
    const count = touched.get(env.key) ?? { runs: 0, evaluations: 0 };
    return {
      ...env,
      runs: count.runs,
      evaluations: count.evaluations,
      wholeRuns: whole.length,
      medianMs: median(whole.map((point) => point.ms)),
      usd: medianUsd(whole.map((point) => point.usd)),
      jobs: jobStats,
    };
  });
  runners.sort((a, b) => b.runs + b.evaluations - (a.runs + a.evaluations));

  const providers = new Set([...envs.values()].map(environmentProvider));
  return {
    repositoryId,
    repository: jobs[0]!.repository,
    workflow,
    days: windowDays(window),
    fewRuns: FEW_RUNS,
    baseline: envs.has(BASELINE) ? BASELINE : null,
    jobs: names.map(([name]) => name),
    runners,
    runs: points,
    // In the catalog's order, which is the Providers page's.
    untried: HOSTED_PROVIDER_IDS.filter(
      (id) => EVALUABLE_PROVIDERS.includes(id) && !providers.has(id),
    ),
    truncated,
  };

  function sumUsd(list: Job[]) {
    let usd = 0;
    for (const job of list) {
      if (job.usd === null) return null;
      usd += job.usd;
    }
    return usd;
  }
}
