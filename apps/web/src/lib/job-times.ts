import type {
  PerformanceReport,
  PerformanceWorkflow,
  Stat,
  JobType,
  WorkflowReport,
} from "@relayrunner/api-types";
import { api } from "@/lib/api";
import { filterQuery, type RunFilters } from "./run-filters.ts";
import { type RangeOptions, reportQuery, type TimeRange } from "./time-range.ts";
import { count } from "@/lib/utils";
import type { Part } from "./job-phases.ts";

// GET /api/job-times: the Performance page's report. The dashboard calls each workflow row
// a WorkflowRow and the report a JobTimesReport.
export type {
  Confidence,
  Environment,
  EnvironmentSummary,
  JobRow,
  JobType,
  Stat,
  WorkflowReport,
  WorkflowRunner,
  WorkflowRunPoint,
} from "@relayrunner/api-types";
export type JobTimesReport = PerformanceReport;
export type WorkflowRow = PerformanceWorkflow;

/** A Stat with no runs behind it. */
export const EMPTY_STAT: Stat = {
  runs: 0,
  successes: 0,
  samples: 0,
  confidence: "none",
  medianMs: null,
  p90Ms: null,
  waitMs: null,
  trend: null,
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  lint: "Lint",
  test: "Tests",
  e2e: "End-to-end",
  build: "Build",
  deploy: "Deploy",
  other: "Other",
};

export type JobRun = {
  id: number;
  runId: number;
  runAttempt: number;
  environment: string;
  conclusion: string | null;
  queuedAt: number | null;
  startedAt: number;
  completedAt: number;
};

/** A step of a job's average run; `cache` marks setup the job has a cache step for. */
export type RunStep = { name: string; part: Part; ms: number; cache?: true };

/**
 * The ranges a report from single jobs offers: as far back as the API keeps them (62 days), so
 * last month fits.
 */
export const JOB_RANGES: RangeOptions = {
  presets: ["24h", "7d", "14d", "30d", "week", "lastweek", "month", "lastmonth"],
};

export function getJobTimes(range: TimeRange, filters: RunFilters = {}) {
  return api<JobTimesReport>(`/job-times?${reportQuery(range, filterQuery(filters))}`);
}

export function getJobRuns(
  range: TimeRange,
  job: { repositoryId: number; workflow: string | null; name: string; matrix: boolean },
) {
  const query = reportQuery(range, {
    repositoryId: String(job.repositoryId),
    name: job.name,
    matrix: String(job.matrix),
    ...(job.workflow && { workflow: job.workflow }),
  });
  return api<{ days: number; runs: JobRun[]; steps: RunStep[] }>(`/job-times/runs?${query}`);
}

/** One workflow on every runner it ran on (GET /api/job-times/workflow). */
export function getWorkflowReport(
  range: TimeRange,
  workflow: { repositoryId: number; workflow: string | null },
) {
  const query = reportQuery(range, {
    repositoryId: String(workflow.repositoryId),
    ...(workflow.workflow && { workflow: workflow.workflow }),
  });
  return api<WorkflowReport>(`/job-times/workflow?${query}`);
}

/** A run's cost at list prices: "Free", "$0.024" under a dime, "$1.20" above, "—" unknown. */
export function runCost(usd: number | null | undefined) {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "Free";
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}

export function getMachineJobTimes(days = 14) {
  return api<{ days: number; machines: Record<string, Stat> }>(`/job-times/machines?days=${days}`);
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// 10s, 15s, 30s, 1m, 2m, 5m, 10m, ... so the axis lands on round times.
export function niceStep(ms: number) {
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
  return steps.find((step) => step >= ms) ?? 3_600_000;
}

/** Whole minutes in short form; "<1" for less than one. */
export function minutesText(ms: number) {
  const minutes = ms / 60_000;
  return minutes > 0 && minutes < 1 ? "<1" : count(Math.round(minutes));
}

/** "0:09", "3:10", "1:02:05": a stopwatch, so times line up in tables. */
export function clock(ms: number | null) {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * How long a job usually takes on the runner it runs on (GET /api/runs/live and a run's jobs): the
 * median and p90 of its newest successful runs there over 14 days, with 5 or more of them.
 */
export type TypicalTime = { medianMs: number; p90Ms: number; samples: number };

/**
 * How far past its median a job has to run before it counts as slow: at least this long and this
 * share of the median, and past its p90 too. Keeps ordinary run-to-run variance (1:31 against a
 * usual 1:22) from reading as a problem.
 */
const SLOW_MIN_MS = 30_000;
const SLOW_MIN_SHARE = 0.25;

/** Whether a job that has run `ranMs` is meaningfully slower than it usually is on its runner. */
export function isSlow(typical: TypicalTime | null | undefined, ranMs: number) {
  if (!typical) return false;
  const over = ranMs - typical.medianMs;
  return ranMs > typical.p90Ms && over >= Math.max(SLOW_MIN_MS, typical.medianMs * SLOW_MIN_SHARE);
}

/**
 * A running job against its usual time: time left before its median, past the median but still
 * within what's normal for it, or meaningfully slower than usual (see `isSlow`).
 */
export type Progress =
  | { state: "left"; leftMs: number; typical: TypicalTime }
  | { state: "normal"; typical: TypicalTime }
  | { state: "slow"; typical: TypicalTime };

export function progressOf(
  typical: TypicalTime | null | undefined,
  ranMs: number,
): Progress | null {
  if (!typical) return null;
  if (ranMs < typical.medianMs) return { state: "left", leftMs: typical.medianMs - ranMs, typical };
  return { state: isSlow(typical, ranMs) ? "slow" : "normal", typical };
}

/**
 * "about 1:20 left" or "slower than usual (2:10)": what a running job's timer says under it, with
 * `format` for the times. Null once it's past its usual time but still normal, since saying so
 * only adds noise.
 */
export function progressText(progress: Progress, format: (ms: number) => string = clock) {
  if (progress.state === "left") return `about ${format(progress.leftMs)} left`;
  if (progress.state === "normal") return null;
  return slowText(progress.typical, format);
}

/** "slower than usual (2:10)". */
export function slowText(typical: TypicalTime, format: (ms: number) => string = clock) {
  return `slower than usual (${format(typical.medianMs)})`;
}

/**
 * About how long until the last of these jobs is done, from their usual times: a running job has
 * its median less what it has run, a queued one its whole median. Null when any of them has no
 * usual time, since the estimate would leave it out.
 */
export function timeLeft(
  jobs: { startedAt: number | null; typical: TypicalTime | null }[],
  now: number,
): number | null {
  let left = 0;
  for (const job of jobs) {
    if (!job.typical) return null;
    const ran = job.startedAt === null ? 0 : now - job.startedAt;
    left = Math.max(left, job.typical.medianMs - ran);
  }
  return jobs.length ? left : null;
}

/** "7 runs", "1 run". */
export function plural(value: number, word: string) {
  return `${count(value)} ${value === 1 ? word : `${word}s`}`;
}

/** The median, "~" in front when under 5 runs back it. */
export function medianText(stat: Stat) {
  return `${stat.confidence === "few" ? "~" : ""}${clock(stat.medianMs)}`;
}

/** "p90 1:24": 9 in 10 successful runs finished within it. "~" in front when under 5 runs. */
export function p90Text(stat: Stat) {
  return `p90 ${stat.confidence === "few" ? "~" : ""}${clock(stat.p90Ms)}`;
}

/** "2.7× faster", "1.4× slower", "about even" (within 10%). */
export function versusLabel(ratio: number) {
  if (ratio > 0.9 && ratio < 1.1) return "about even";
  return ratio < 1 ? `${(1 / ratio).toFixed(1)}× faster` : `${ratio.toFixed(1)}× slower`;
}

// One color per environment, in the order the report lists them.
const ENV_COLORS = ["#58a6ff", "#3fb950", "#d2a8ff", "#f0883e", "#e3b341", "#79c0ff", "#ff7b72"];

export function environmentColor(index: number) {
  return ENV_COLORS[index % ENV_COLORS.length];
}
