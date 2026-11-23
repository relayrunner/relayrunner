import type { FailureCause } from "@relayrunner/api-types";
import { api } from "@/lib/api";
import { pageQuery } from "@/lib/query";
import type { RouteWalk } from "@/lib/route-walk";
import type { Environment, JobRun, TypicalTime } from "@/lib/job-times";
import type { WorkflowRef } from "@/lib/workflow-ref";
import { reportQuery, type TimeRange } from "@/lib/time-range";
export type RunStatus = "queued" | "in_progress" | "completed";

/** One attempt of a workflow run (GET /api/runs). Times are epoch ms. */
export type Run = {
  repositoryId: number;
  repository: string;
  runId: number;
  runAttempt: number;
  workflow: string | null;
  /** The commit or PR title. Null for runs from before the App sent workflow_run. */
  title: string | null;
  event: string | null;
  actor: string | null;
  /** The commit the run is for. Null when only job data is known. */
  sha: string | null;
  branch: string | null;
  pullRequest: number | null;
  url: string;
  status: RunStatus;
  conclusion: string | null;
  startedAt: number | null;
  /** When the run last changed. */
  updatedAt: number;
  wallMs: number | null;
  /** Environment keys, as in RunsReport.environments. */
  environments: string[];
  routed: boolean;
  /** The workflow's p90 over its successful runs in the report's window. */
  usualMs: number | null;
  /** For a cancelled run, the newer run on the same branch that it was cancelled for. */
  supersededBy: Pick<Run, "runId" | "runAttempt"> | null;
};

export type RunsReport = {
  /** Days the usual times come from: the range, or the 14 days up to its end if that's longer. */
  days: number;
  environments: Environment[];
  runs: Run[];
  truncated: boolean;
};

export type RunJob = {
  id: number;
  name: string;
  /** Where it ran, or for a queued job the runner it's waiting for. */
  environment: string | null;
  status: RunStatus;
  conclusion: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** How long it usually takes on its runner, when it has 5+ successful runs there. */
  typical: TypicalTime | null;
};

/** What a run's detail says about the run itself. Null when nothing of the run is known. */
export type RunHeader = Pick<
  Run,
  | "repository"
  | "workflow"
  | "title"
  | "event"
  | "actor"
  | "sha"
  | "branch"
  | "pullRequest"
  | "url"
  | "status"
  | "conclusion"
>;

/** A run's jobs, and how its pick walked the runner order when RelayRunner routed it. */
export type RunJobs = {
  run: RunHeader | null;
  environments: Environment[];
  jobs: RunJob[];
  walk: RouteWalk | null;
};

/** One step of a job, from GitHub. Times are epoch ms. */
export type JobStep = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

/** A run attempt as History's `?run=` names it: `repositoryId-runId-runAttempt`. */
export type RunIds = Pick<Run, "repositoryId" | "runId" | "runAttempt">;
export const runParam = (run: RunIds) => `${run.repositoryId}-${run.runId}-${run.runAttempt}`;
export function parseRunParam(value: unknown): RunIds | undefined {
  const match = typeof value === "string" && /^(\d+)-(\d+)-(\d+)$/.exec(value);
  if (!match) return undefined;
  return { repositoryId: Number(match[1]), runId: Number(match[2]), runAttempt: Number(match[3]) };
}

/**
 * The CPU and memory a job used, as the connected machine that ran it sampled them. CPU is a share
 * (0 to 1) of the job's `cpus`; memory is in MB, out of `memoryMb`.
 */
export type JobUsage = {
  cpuP95: number;
  cpuPeak: number;
  memoryP95Mb: number;
  memoryPeakMb: number;
  cpus: number;
  memoryMb: number;
  samples: number;
};

/** A job a runner finished (GET /api/runs/jobs). */
export type HistoryJob = JobRun &
  // Its run's, null for runs from before they were stored.
  Pick<Run, "sha" | "actor" | "branch" | "pullRequest" | "title"> & {
    repositoryId: number;
    repository: string;
    workflow: string | null;
    name: string;
    /** Only for jobs on connected machines whose CLI reports it. */
    usage?: JobUsage;
  };

export type JobsReport = {
  days: number;
  environments: Environment[];
  /** Newest first. */
  jobs: HistoryJob[];
  truncated: boolean;
};

/** A job's page on GitHub. */
export const jobUrl = (job: Pick<HistoryJob, "repository" | "runId" | "id">) =>
  `https://github.com/${job.repository}/actions/runs/${job.runId}/job/${job.id}`;

/** A pull request's page on GitHub. */
export const pullRequestUrl = (repository: string, number: number) =>
  `https://github.com/${repository}/pull/${number}`;

/** Both History views open on the last week. */
export const HISTORY_DEFAULT_RANGE: TimeRange = "7d";

/** The workspace's runs in a range, or with `only`, just one workflow's. */
export function getRuns(range: TimeRange, only?: WorkflowRef) {
  const query = reportQuery(range);
  if (only) {
    const filter = new URLSearchParams({ repo: only.repository, workflow: only.workflow });
    return api<RunsReport>(`/runs?${query}&${filter}`);
  }
  return api<RunsReport>(`/runs?${query}`);
}

export function getJobs(range: TimeRange) {
  return api<JobsReport>(`/runs/jobs?${reportQuery(range)}`);
}

// History's reports, a load per range.
export const runsQuery = (range: TimeRange) => pageQuery(["runs", range], () => getRuns(range));
// Each range is its own load, since the newest jobs alone can fill a busy workspace's list.
export const jobsQuery = (range: TimeRange) => pageQuery(["jobs", range], () => getJobs(range));

export function getRunJobs(run: RunIds) {
  return api<RunJobs>(`/runs/${run.repositoryId}/${run.runId}/${run.runAttempt}/jobs`);
}

/** A job's steps, or null when GitHub no longer has the job. */
export function getJobSteps(jobId: number) {
  return api<{ steps: JobStep[] | null }>(`/runs/jobs/${jobId}/steps`).then(({ steps }) => steps);
}

/** Why a job failed: its failed step, GitHub's annotations and the end of its log. */
export type JobFailure = {
  /** "3. Run tests", or null when GitHub sent no failed step. */
  failedStep: string | null;
  /** True when the runner failed the job before any of its steps started. */
  runnerFailed: boolean;
  annotations: string[];
  /** The log's last lines up to its last error, or null when GitHub no longer has the log. */
  log: string[] | null;
  /** What most likely caused it, from the AI model, or null when AI is off or couldn't tell. */
  cause: FailureCause | null;
};

export type { FailureCause };

export function getJobFailure(jobId: number) {
  return api<JobFailure>(`/runs/jobs/${jobId}/failure`);
}

/** What started a run, the way people say it: "PR #12", "push", "manual". */
export function triggerText(run: Pick<Run, "event" | "pullRequest">) {
  if (!run.event) return null;
  if (run.event.startsWith("pull_request"))
    return run.pullRequest ? `PR #${run.pullRequest}` : "pull request";
  if (run.event === "workflow_dispatch") return "manual";
  return run.event.replaceAll("_", " ");
}

/** A failed result: the job or run broke or ran out of time, rather than being cancelled. */
export const isFailure = (conclusion: string | null) =>
  conclusion === "failure" || conclusion === "timed_out";

/** A wait this long is worth pointing out. */
export const LONG_WAIT_MS = 60_000;
export const isLongWait = (wait: number | null): wait is number =>
  wait !== null && wait >= LONG_WAIT_MS;
