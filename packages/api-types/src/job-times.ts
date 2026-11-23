// How long jobs take on each runner (GET /api/job-times, apps/api/src/job-times.ts) and each
// workflow's whole-run times beside them (the Performance page, apps/api/src/runs.ts). Times are ms.
import type { RunnerSize } from "@relayrunner/providers";
import type { DeviceKind } from "./device.ts";

/** How sure a time is: none (not run), few (under 5 runs), low (5 to 19), ok (20+). */
export type Confidence = "none" | "few" | "low" | "ok";

export type Stat = {
  /** Runs in the window that a runner finished, successful or not. */
  runs: number;
  successes: number;
  /** Successful runs behind the times, at most the report's sampleCap. */
  samples: number;
  confidence: Confidence;
  medianMs: number | null;
  p90Ms: number | null;
  /** Median wait from queued to started. Null for rows from before it was stored. */
  waitMs: number | null;
  /**
   * The median against the previous window of the same length, as a fraction (0.18 is 18%
   * slower). Null when either window has too few samples, or nothing was compared.
   */
  trend: number | null;
};

export type Environment = {
  /** e.g. `github:linux-2-core`, `machine:<id>`, `container`. */
  key: string;
  label: string;
  detail: string;
  /** Its vCPUs and memory, when the label or the service says. */
  size?: RunnerSize;
  /**
   * `machine:<id>` only: how it joined (a `relayrunner connect` machine or a runner added from
   * GitHub) and the device it reported, so the dashboard can pick its icon.
   */
  machine?: { source: "connect" | "github"; kind: DeviceKind | null; model: string | null };
};

export type EnvironmentSummary = Environment & {
  stat: Stat;
  /**
   * Jobs sent here that no runner picked up. With `stat.runs`, the share it started, which says
   * how reliable the runner is whatever the jobs' own results.
   */
  missed: number;
  /**
   * Against the baseline on the jobs both ran often enough: the median of this environment's
   * median over the baseline's (0.5 is twice as fast). Null for the baseline itself or with too
   * few shared jobs.
   */
  versus: { ratio: number; sharedJobs: number } | null;
};

/** What a job does, from the AI model (apps/api/src/ai/job-type.ts). */
export type JobType = "lint" | "test" | "e2e" | "build" | "deploy" | "other";

export type JobRow = {
  name: string;
  byEnvironment: Record<string, Stat>;
  /** Matrix legs (`test (node 24)`), when this row groups them under their shared name. */
  legs?: JobRow[];
  /** What the job does, once the AI model has read it. */
  type?: JobType;
};

export type WorkflowRow = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  jobs: JobRow[];
};

export type JobTimesReport = {
  days: number;
  /** Whether times carry a trend against the window before. */
  trend: boolean;
  sampleCap: number;
  /** Runs a job needs on both runners to count toward `versus`. */
  fewRuns: number;
  /** Shared jobs a runner needs before it gets a `versus`. */
  minSharedJobs: number;
  baseline: string | null;
  environments: EnvironmentSummary[];
  workflows: WorkflowRow[];
};

/** A workflow on the Performance page: its jobs' times and its whole-run times. */
export type PerformanceWorkflow = WorkflowRow &
  WorkflowCost & {
    /** Run start to last job done, like the History page. Null with no finished runs. */
    wall: Stat | null;
  };

/** The Performance page: job times per runner, plus each workflow's whole-run times. */
export type PerformanceReport = Omit<JobTimesReport, "workflows"> & {
  workflows: PerformanceWorkflow[];
};

/**
 * Which runner ran a workflow fastest against GitHub's: its whole runs that ran every job on one
 * runner, FEW_RUNS+ on both. `ratio` is its median over GitHub's (0.6 is 40% less time).
 */
export type FastestRunner = { environment: string; ratio: number };

/** A workflow's cost and runners in the window (apps/api/src/workflow-compare.ts). */
export type WorkflowCost = {
  /** Median list-price cost of its successful runs, in USD. Null when none had a price. */
  usd: number | null;
  /** Environment keys its jobs ran on, most runs first. */
  environments: string[];
  fastest: FastestRunner | null;
  /** Time its jobs ran on a runner in the window, summed, for the page's CI time. */
  runMs: number;
  /** What they cost at list prices, in USD, leaving out jobs with no price. */
  spentUsd: number;
};

/** One job of a workflow on one runner: its successful runs' median time and cost. */
export type WorkflowJobStat = { runs: number; medianMs: number | null; usd: number | null };

/** A runner that ran a workflow in the window, for the workflow page's Runners table. */
export type WorkflowRunner = Environment & {
  /** Runs it ran a job of, evaluations counted apart. */
  runs: number;
  evaluations: number;
  /** Successful runs that ran every job here. */
  wholeRuns: number;
  /** Their median time and cost. Null with none. */
  medianMs: number | null;
  usd: number | null;
  /** By job name (matrix legs together), from successful jobs. */
  jobs: Record<string, WorkflowJobStat>;
};

/** One successful run, for the workflow page's chart. */
export type WorkflowRunPoint = {
  runId: number;
  runAttempt: number;
  /** When its last job finished, epoch ms. */
  at: number;
  /** First job queued to last finished. */
  ms: number;
  usd: number | null;
  /** The runner of every job, or null when its jobs ran in more than one place. */
  environment: string | null;
  /** A provider evaluation's run. */
  evaluation: boolean;
  /** Each job: its run time, its wait for a runner (null when GitHub sent no queue time), cost. */
  jobs: {
    name: string;
    environment: string;
    ms: number;
    waitMs: number | null;
    usd: number | null;
  }[];
};

/** GET /api/job-times/workflow: one workflow on every runner it ran on. */
export type WorkflowReport = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  days: number;
  fewRuns: number;
  /** The runner the others are compared with, when it ran the workflow. */
  baseline: string | null;
  /** Job names (matrix legs together), most run first. */
  jobs: string[];
  runners: WorkflowRunner[];
  /** Successful runs, oldest first. */
  runs: WorkflowRunPoint[];
  /** Providers that could be evaluated on it and haven't run it in the window. */
  untried: string[];
  /** More jobs fell in the window than the report reads. */
  truncated: boolean;
};
