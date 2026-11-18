import type { RunnerSize } from "@relayrunner/providers";
import type { DeviceKind } from "@/lib/device";
import { api } from "@/lib/api";
import { count } from "@/lib/utils";

/** How sure a time is: none (not run), few (under 5 runs), low (5 to 19), ok (20+). */
export type Confidence = "none" | "few" | "low" | "ok";

/** One job's (or workflow's) times on one environment (GET /api/job-times). Times are ms. */
export type Stat = {
  runs: number;
  successes: number;
  /** Successful runs behind the times, at most the report's sampleCap. */
  samples: number;
  confidence: Confidence;
  medianMs: number | null;
  p90Ms: number | null;
  waitMs: number | null;
  /** Against the window just before, same length: 0.18 is 18% slower. */
  trend: number | null;
};

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

export type Environment = {
  key: string;
  label: string;
  detail: string;
  /** Its vCPUs and memory, when the label or the service says. */
  size?: RunnerSize;
  /** `machine:<id>` only: how it joined and the device it reported, for its icon. */
  machine?: { source: "connect" | "github"; kind: DeviceKind | null; model: string | null };
};

export type EnvironmentSummary = Environment & {
  stat: Stat;
  /** Jobs sent here that no runner picked up within 10 minutes. */
  missed: number;
  /** This environment's median over the baseline's on shared jobs: 0.5 is twice as fast. */
  versus: { ratio: number; sharedJobs: number } | null;
};

export type JobRow = {
  name: string;
  byEnvironment: Record<string, Stat>;
  legs?: JobRow[];
  /** What the job does, from the AI model, once it has read the job (apps/api/src/ai/job-type.ts). */
  type?: JobType;
};

export type JobType = "lint" | "test" | "e2e" | "build" | "deploy" | "other";

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  lint: "Lint",
  test: "Tests",
  e2e: "End-to-end",
  build: "Build",
  deploy: "Deploy",
  other: "Other",
};

export type WorkflowRow = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  /** Whole-run times: run start to last job done, like the History page. */
  wall: Stat | null;
  jobs: JobRow[];
};

export type JobTimesReport = {
  days: number;
  /** Whether times carry a trend against the window before (not on 30 days). */
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

export function getJobTimes(days: number) {
  return api<JobTimesReport>(`/job-times?days=${days}`);
}

export function getJobRuns(
  days: number,
  job: { repositoryId: number; workflow: string | null; name: string; matrix: boolean },
) {
  const query = new URLSearchParams({
    days: String(days),
    repositoryId: String(job.repositoryId),
    name: job.name,
    matrix: String(job.matrix),
  });
  if (job.workflow) query.set("workflow", job.workflow);
  return api<{ days: number; runs: JobRun[] }>(`/job-times/runs?${query}`);
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
 * A running job against its usual time: time left before its median, past the median but within
 * what's normal for it, or slower than 9 in 10 of its runs.
 */
export type Progress =
  | { state: "left"; leftMs: number; typical: TypicalTime }
  | { state: "late"; typical: TypicalTime }
  | { state: "slow"; typical: TypicalTime };

export function progressOf(
  typical: TypicalTime | null | undefined,
  ranMs: number,
): Progress | null {
  if (!typical) return null;
  if (ranMs < typical.medianMs) return { state: "left", leftMs: typical.medianMs - ranMs, typical };
  return { state: ranMs > typical.p90Ms ? "slow" : "late", typical };
}

/**
 * "about 1:20 left", "usual 2:10", "slower than usual (2:10)": what a running job's timer says
 * under it, with `format` for the times.
 */
export function progressText(progress: Progress, format: (ms: number) => string = clock) {
  if (progress.state === "left") return `about ${format(progress.leftMs)} left`;
  if (progress.state === "late") return `usual ${format(progress.typical.medianMs)}`;
  return `slower than usual (${format(progress.typical.medianMs)})`;
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

/** A made-up Stat for the sample reports: `samples` successful runs around `medianS` seconds. */
export function sampleStat(
  medianS: number,
  samples: number,
  runs = samples,
  trend: number | null = null,
): Stat {
  return {
    runs,
    successes: Math.round(runs * 0.96),
    samples: Math.min(samples, 50),
    confidence: samples === 0 ? "none" : samples < 5 ? "few" : samples < 20 ? "low" : "ok",
    medianMs: medianS * 1000,
    p90Ms: medianS * 1300,
    waitMs: samples ? 6000 : null,
    trend,
  };
}

/** Example report for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleJobTimes(days: number): JobTimesReport {
  const stat = sampleStat;
  const linux = "github:linux-2-core";
  const mac = "machine:sample";
  const container = "container";
  const macos = "github:macos";
  return {
    days,
    trend: days * 2 <= 31,
    sampleCap: 50,
    fewRuns: 5,
    minSharedJobs: 3,
    baseline: linux,
    environments: [
      {
        key: linux,
        label: "ubuntu-latest",
        detail: "GitHub-hosted",
        size: { vcpus: 2, memoryGb: 8 },
        stat: stat(108, 50, 412),
        missed: 0,
        versus: null,
      },
      {
        key: mac,
        label: "Ada's MacBook Pro",
        detail: "MacBook Pro · Apple M3 Max",
        machine: { source: "connect", kind: "laptop", model: "MacBook Pro" },
        stat: stat(41, 50, 198),
        missed: 2,
        versus: { ratio: 0.37, sharedJobs: 3 },
      },
      {
        key: "machine:sample-mini",
        label: "studio-mini",
        detail: "Mac mini · Apple M4 Pro",
        machine: { source: "connect", kind: "desktop", model: "Mac mini" },
        stat: stat(23, 23, 171),
        missed: 0,
        versus: null,
      },
      {
        key: "machine:sample-github",
        label: "build-01",
        detail: "",
        machine: { source: "github", kind: null, model: null },
        stat: stat(64, 50, 240),
        missed: 0,
        versus: null,
      },
      {
        key: "self-hosted:default",
        label: "Self-hosted",
        detail: "",
        stat: stat(88, 50, 260),
        missed: 0,
        versus: null,
      },
      {
        key: container,
        label: "Cloudflare Container",
        detail: "standard-1",
        size: { vcpus: 0.5, memoryGb: 4 },
        stat: stat(19, 50, 61),
        missed: 0,
        versus: { ratio: 1.03, sharedJobs: 3 },
      },
      {
        key: macos,
        label: "macOS",
        detail: "GitHub-hosted",
        stat: stat(400, 9),
        missed: 0,
        versus: null,
      },
    ],
    workflows: [
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "CI",
        wall: stat(214, 50, 162, 0.12),
        jobs: [
          {
            name: "test",
            byEnvironment: { [linux]: stat(190, 50, 150, 0.18), [mac]: stat(81, 44) },
            legs: [
              {
                name: "test (node 22)",
                byEnvironment: { [linux]: stat(182, 50), [mac]: stat(78, 15) },
              },
              {
                name: "test (node 24)",
                byEnvironment: { [linux]: stat(192, 50), [mac]: stat(81, 16) },
              },
            ],
          },
          {
            name: "typecheck",
            byEnvironment: {
              [linux]: stat(92, 50),
              [mac]: stat(38, 40),
              [container]: stat(168, 7),
            },
          },
          {
            name: "lint",
            byEnvironment: {
              [linux]: stat(41, 50, 50, -0.31),
              [mac]: stat(12, 31),
              [container]: stat(24, 22),
            },
          },
          { name: "build", byEnvironment: { [linux]: stat(125, 50), [mac]: stat(52, 3) } },
        ],
      },
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "Release",
        wall: stat(262, 9, 10),
        jobs: [
          { name: "build-macos", byEnvironment: { [mac]: stat(235, 12), [macos]: stat(400, 9) } },
        ],
      },
    ],
  };
}
