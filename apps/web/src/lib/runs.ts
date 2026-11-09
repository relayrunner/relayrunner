import { api } from "@/lib/api";
import type { Environment } from "@/lib/job-times";

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
  completedAt: number | null;
  wallMs: number | null;
  jobs: number;
  /** Environment keys, as in RunsReport.environments. */
  environments: string[];
  routed: boolean;
  /** The workflow's p90 over its successful runs in the last usualDays days. */
  usualMs: number | null;
};

export type RunsReport = {
  days: number;
  usualDays: number;
  environments: Environment[];
  runs: Run[];
  truncated: boolean;
};

export type RunJob = {
  id: number;
  name: string;
  environment: string | null;
  status: string;
  conclusion: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type RunJobs = { environments: Environment[]; jobs: RunJob[] };

export function getRuns(days: number) {
  return api<RunsReport>(`/runs?days=${days}`);
}

export function getRunJobs(run: Pick<Run, "repositoryId" | "runId" | "runAttempt">) {
  return api<RunJobs>(`/runs/${run.repositoryId}/${run.runId}/${run.runAttempt}/jobs`);
}

/** "52s", "3m 51s", "1h 2m". */
export function elapsed(ms: number | null) {
  if (ms === null) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** What started a run, the way people say it: "PR #12", "push", "manual". */
export function triggerText(run: Pick<Run, "event" | "pullRequest">) {
  if (!run.event) return null;
  if (run.event.startsWith("pull_request"))
    return run.pullRequest ? `PR #${run.pullRequest}` : "pull request";
  if (run.event === "workflow_dispatch") return "manual";
  return run.event.replaceAll("_", " ");
}

/** A wait this long is worth pointing out. */
export const LONG_WAIT_MS = 60_000;

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
    completedAt: now - 9 * MIN,
    wallMs: 161_000,
    jobs: 3,
    environments: ["container", "github:linux-2-core"],
    routed: true,
    usualMs: 170_000,
    ...run,
  };
}

/** Example runs for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleRuns(days: number): RunsReport {
  return {
    days,
    usualDays: 14,
    environments: [
      { key: "github:linux-2-core", label: "Linux 2-core", detail: "GitHub-hosted" },
      { key: "container", label: "Cloudflare Container", detail: "standard-1" },
      { key: "machine:sample", label: "Zach's MacBook Pro", detail: "MacBook Pro · Apple M3 Max" },
    ],
    runs: [
      sampleRun({
        runId: 6,
        title: "docs: add the runs view design",
        status: "in_progress",
        conclusion: null,
        startedAt: now - 65_000,
        completedAt: null,
        wallMs: null,
        jobs: 2,
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
        completedAt: now - 21 * MIN,
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
        completedAt: now - 39 * MIN,
        wallMs: 52_000,
        usualMs: 61_000,
        jobs: 1,
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
        completedAt: now - 9 * 60 * MIN + 30_000,
        wallMs: 30_000,
        usualMs: null,
        jobs: 1,
        environments: ["github:linux-2-core"],
      }),
    ],
    truncated: false,
  };
}

/** Example jobs for a sample run. */
export function sampleRunJobs(run: Pick<Run, "runId" | "startedAt">): RunJobs {
  const start = run.startedAt ?? now;
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
  const report = sampleRuns(14);
  return {
    environments: report.environments,
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
