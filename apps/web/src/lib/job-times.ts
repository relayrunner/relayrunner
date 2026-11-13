import type { RunnerSize } from "@relayrunner/providers";
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
  p25Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
  waitMs: number | null;
  /** Newer half of the runs against the older half: 0.18 is 18% slower. */
  trend: number | null;
};

export type Environment = {
  key: string;
  label: string;
  detail: string;
  /** Its vCPUs and memory, when the label or the service says. */
  size?: RunnerSize;
};

export type EnvironmentSummary = Environment & {
  stat: Stat;
  /** Jobs sent here that no runner picked up within 10 minutes. */
  missed: number;
  /** This environment's median over the baseline's on shared jobs: 0.5 is twice as fast. */
  versus: { ratio: number; sharedJobs: number } | null;
};

export type JobRow = { name: string; byEnvironment: Record<string, Stat>; legs?: JobRow[] };

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

export const DAY_MS = 86_400_000;

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

/** "7 runs", "1 run". */
export function plural(value: number, word: string) {
  return `${count(value)} ${value === 1 ? word : `${word}s`}`;
}

/** The median, "~" in front when under 5 runs back it. */
export function medianText(stat: Stat) {
  return `${stat.confidence === "few" ? "~" : ""}${clock(stat.medianMs)}`;
}

/** p90 with 20+ runs, otherwise the middle half of the runs. */
export function spreadText(stat: Stat) {
  return stat.confidence === "ok"
    ? `p90 ${clock(stat.p90Ms)}`
    : `middle half ${clock(stat.p25Ms)}–${clock(stat.p75Ms)}`;
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
    p25Ms: medianS * 900,
    p75Ms: medianS * 1150,
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
    sampleCap: 50,
    fewRuns: 5,
    minSharedJobs: 3,
    baseline: linux,
    environments: [
      {
        key: linux,
        label: "Linux 2-core",
        detail: "GitHub-hosted",
        size: { vcpus: 2, memoryGb: 8 },
        stat: stat(108, 50, 412),
        missed: 0,
        versus: null,
      },
      {
        key: mac,
        label: "Zach's MacBook Pro",
        detail: "MacBook Pro · Apple M3 Max",
        stat: stat(41, 50, 198),
        missed: 2,
        versus: { ratio: 0.37, sharedJobs: 3 },
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
