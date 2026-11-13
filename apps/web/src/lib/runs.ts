import { api } from "@/lib/api";
import type { Environment, JobRun } from "@/lib/job-times";

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
};

export type RunsReport = {
  /** The window: runs that changed in the last `days` days. */
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
};

/** What a run's detail says about the run itself. Null when nothing of the run is known. */
export type RunHeader = Pick<
  Run,
  | "repository"
  | "workflow"
  | "title"
  | "event"
  | "actor"
  | "branch"
  | "pullRequest"
  | "url"
  | "status"
  | "conclusion"
>;

export type RunJobs = { run: RunHeader | null; environments: Environment[]; jobs: RunJob[] };

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
export type HistoryJob = JobRun & {
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

export function getRuns() {
  return api<RunsReport>("/runs");
}

export function getJobs(days: number) {
  return api<JobsReport>(`/runs/jobs?days=${days}`);
}

export function getRunJobs(run: RunIds) {
  return api<RunJobs>(`/runs/${run.repositoryId}/${run.runId}/${run.runAttempt}/jobs`);
}

/** A job's steps, or null when GitHub no longer has the job. */
export function getJobSteps(jobId: number) {
  return api<{ steps: JobStep[] | null }>(`/runs/jobs/${jobId}/steps`).then(({ steps }) => steps);
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

const now = Date.now();
const MIN = 60_000;

function sampleRun(run: Partial<Run> & Pick<Run, "runId">): Run {
  return {
    repositoryId: 1,
    repository: "acme/app",
    runAttempt: 1,
    workflow: "CI",
    title: null,
    event: "push",
    actor: "zach",
    branch: "main",
    pullRequest: null,
    url: "https://github.com",
    status: "completed",
    conclusion: "success",
    startedAt: now - 12 * MIN,
    updatedAt: now - 9 * MIN,
    wallMs: 161_000,
    environments: ["container", "github:linux-2-core"],
    routed: true,
    usualMs: 170_000,
    ...run,
  };
}

const SAMPLE_ENVIRONMENTS: Environment[] = [
  { key: "github:linux-2-core", label: "Linux 2-core", detail: "GitHub-hosted" },
  { key: "container", label: "Cloudflare Container", detail: "standard-1" },
  { key: "machine:sample", label: "Zach's MacBook Pro", detail: "MacBook Pro · Apple M3 Max" },
];

/** Example runs for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleRuns(): RunsReport {
  return {
    days: 14,
    environments: SAMPLE_ENVIRONMENTS,
    runs: [
      sampleRun({
        runId: 6,
        title: "docs: add the runs view design",
        status: "in_progress",
        conclusion: null,
        startedAt: now - 65_000,
        updatedAt: now - 5_000,
        wallMs: null,
      }),
      sampleRun({
        runId: 5,
        title: "feat(api,web): count lint runs in the free check savings",
        event: "pull_request",
        pullRequest: 193,
        branch: "claude/lint-savings",
      }),
      sampleRun({
        runId: 4,
        repository: "acme/ci-tests",
        title: "fix(api): start a new pick runner when a relay job is left without one",
        event: "pull_request",
        pullRequest: 12,
        branch: "claude/fix-picks",
        conclusion: "failure",
        startedAt: now - 25 * MIN,
        updatedAt: now - 21 * MIN,
        wallMs: 231_000,
        usualMs: 120_000,
        environments: ["container", "machine:sample", "github:linux-2-core"],
      }),
      sampleRun({
        runId: 3,
        workflow: "Release",
        title: "chore: release 1.4.0",
        routed: false,
        startedAt: now - 40 * MIN,
        updatedAt: now - 39 * MIN,
        wallMs: 52_000,
        usualMs: 61_000,
        environments: ["github:linux-2-core"],
      }),
      sampleRun({
        runId: 2,
        workflow: "Nightly",
        title: null,
        event: "schedule",
        actor: null,
        conclusion: "cancelled",
        routed: false,
        startedAt: now - 9 * 60 * MIN,
        updatedAt: now - 9 * 60 * MIN + 30_000,
        wallMs: 30_000,
        usualMs: null,
        environments: ["github:linux-2-core"],
      }),
    ],
    truncated: false,
  };
}

/** Example jobs for a sample run: one from sampleRuns, or one the sample job list names. */
export function sampleRunJobs(run: Pick<Run, "runId">): RunJobs {
  const listed = sampleRuns().runs.find((each) => each.runId === run.runId);
  const header: RunHeader = {
    repository: "acme/app",
    workflow: "CI",
    title: null,
    event: "push",
    actor: "zach",
    branch: "main",
    pullRequest: null,
    url: "https://github.com",
    status: "completed",
    conclusion: "success",
    ...listed,
  };
  if (!listed) {
    const jobs = sampleJobs(14).jobs.filter((job) => job.runId === run.runId);
    return {
      run: jobs[0]
        ? { ...header, repository: jobs[0].repository, workflow: jobs[0].workflow }
        : null,
      environments: SAMPLE_ENVIRONMENTS,
      jobs: jobs.reverse().map((job) => ({ ...job, status: "completed" })),
    };
  }
  const start = listed.startedAt ?? now;
  const job = (
    id: number,
    name: string,
    environment: string,
    waitS: number,
    runS: number,
    conclusion = "success",
  ): RunJob => ({
    id,
    name,
    environment,
    status: "completed",
    conclusion,
    queuedAt: start,
    startedAt: start + waitS * 1000,
    completedAt: start + (waitS + runS) * 1000,
  });
  if (run.runId === 6)
    return {
      run: header,
      environments: SAMPLE_ENVIRONMENTS,
      jobs: [
        job(61, "Lint", "container", 2, 21),
        {
          ...job(62, "Test", "github:linux-2-core", 6, 0),
          status: "in_progress",
          conclusion: null,
          completedAt: null,
        },
        {
          ...job(63, "Typecheck", "machine:sample", 0, 0),
          status: "queued",
          conclusion: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    };
  return {
    run: header,
    environments: SAMPLE_ENVIRONMENTS,
    jobs:
      run.runId === 4
        ? [
            job(41, "Lint", "container", 22, 24),
            job(42, "Typecheck", "machine:sample", 190, 41),
            job(43, "Test", "github:linux-2-core", 8, 150, "failure"),
          ]
        : [job(51, "Lint", "container", 20, 23), job(52, "Test", "github:linux-2-core", 7, 131)],
  };
}

/** Example job list for `VITE_AUTH_DISABLED=true` dev builds. */
export function sampleJobs(days: number): JobsReport {
  const names = ["Lint", "Typecheck", "Test", "Build"];
  const environments = [
    "container",
    "machine:sample",
    "github:linux-2-core",
    "github:linux-2-core",
  ];
  const jobs = Array.from({ length: 36 }, (_, index): HistoryJob => {
    const completedAt = now - index * 37 * MIN;
    const runMs = (20 + ((index * 53) % 170)) * 1000;
    const startedAt = completedAt - runMs;
    return {
      id: 1000 - index,
      runId: 500 - Math.floor(index / 4),
      runAttempt: 1,
      repositoryId: 1,
      repository: index % 9 === 4 ? "acme/ci-tests" : "acme/app",
      workflow: index % 7 === 3 ? "Release" : "CI",
      name: names[index % 4]!,
      environment: environments[index % 4]!,
      conclusion: index % 11 === 5 ? "failure" : index % 13 === 7 ? "cancelled" : "success",
      queuedAt: startedAt - ((index * 17) % 90) * 1000,
      startedAt,
      completedAt,
      // The Mac's jobs report what they used.
      ...(index % 4 === 1 && {
        usage: {
          cpuP95: 0.25 + ((index * 29) % 70) / 100,
          cpuPeak: Math.min(0.4 + ((index * 29) % 70) / 100, 1),
          memoryP95Mb: 900 + ((index * 337) % 2600),
          memoryPeakMb: 1100 + ((index * 337) % 2600),
          cpus: 4,
          memoryMb: 8192,
          samples: Math.round(runMs / 5000),
        },
      }),
    };
  });
  return { days, environments: SAMPLE_ENVIRONMENTS, jobs, truncated: false };
}

/** Example steps for a sample job, spread over its run time. */
export function sampleJobSteps(job: Pick<RunJob, "startedAt" | "completedAt" | "conclusion">) {
  const names = [
    "Set up job",
    "Run actions/checkout@v6",
    "Run pnpm/action-setup@v6",
    "Run actions/setup-node@v6",
    "Run pnpm install --frozen-lockfile",
    "Run pnpm check",
    "Post Run actions/checkout@v6",
    "Complete job",
  ];
  const shares = [0.04, 0.06, 0.05, 0.1, 0.25, 0.48, 0.01, 0.01];
  const start = job.startedAt ?? now;
  const end = job.completedAt ?? now;
  let at = start;
  return names.map((name, index): JobStep => {
    const from = at;
    at = index === names.length - 1 ? end : from + (end - start) * shares[index]!;
    const failed = job.conclusion === "failure" && name === "Run pnpm check";
    const live = job.completedAt === null && index === names.length - 1;
    return {
      number: index + 1,
      name,
      status: live ? "in_progress" : "completed",
      conclusion: live ? null : failed ? "failure" : "success",
      startedAt: from,
      completedAt: at,
    };
  });
}
