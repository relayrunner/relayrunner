import { api } from "@/lib/api";

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

/** Where an environment's minutes come from: your machines, another cloud, or GitHub-hosted. */
export type EnvironmentKind = "machine" | "cloud" | "github";

export type Environment = { key: string; label: string; detail: string; kind: EnvironmentKind };

/** Every run's minutes on one environment, failures too. */
export type Minutes = {
  runs: number;
  runMs: number;
  /** Charged to GitHub's included minutes, in Linux 2-core minutes, each job rounded up. */
  quotaMinutes: number;
  /** Run time per day of the window, oldest first; the last day ends now. */
  dailyMs: number[];
};

export type EnvironmentSummary = Environment & {
  stat: Stat;
  /** This environment's median over the baseline's on shared jobs: 0.5 is twice as fast. */
  versus: { ratio: number; sharedJobs: number } | null;
};

export type JobRow = {
  name: string;
  byEnvironment: Record<string, Stat>;
  minutes: Record<string, Minutes>;
  legs?: JobRow[];
};

export type WorkflowRow = {
  repositoryId: number;
  repository: string;
  workflow: string | null;
  /** Null when unknown; GitHub-hosted minutes then count as quota. */
  private: boolean | null;
  byEnvironment: Record<string, Stat>;
  jobs: JobRow[];
};

export type JobTimesReport = {
  days: number;
  sampleCap: number;
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

/** One GitHub account's Actions minutes this billing cycle (GET /api/usage/actions). */
export type AccountMinutes = {
  installationId: number;
  accountLogin: string;
  status: "ok" | "not_available";
  quotaMinutes: number | null;
  usedMinutes: number;
};

export function getActionsUsage() {
  return api<{ accounts: AccountMinutes[] }>("/usage/actions");
}

export function getMachineJobTimes(days = 14) {
  return api<{ days: number; machines: Record<string, Stat> }>(`/job-times/machines?days=${days}`);
}

export const DAY_MS = 86_400_000;

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
export function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
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
  return ENV_COLORS[index % ENV_COLORS.length] ?? "#8b949e";
}

/** Example report for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleJobTimes(days: number): JobTimesReport {
  // Deterministic noise, so the sample looks the same on every load.
  let seed = 7 + days;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const stat = (medianS: number, runs: number): Stat => {
    const samples = Math.min(runs, 50);
    return {
      runs,
      successes: Math.round(runs * 0.96),
      samples,
      confidence: samples === 0 ? "none" : samples < 5 ? "few" : samples < 20 ? "low" : "ok",
      medianMs: medianS * 1000,
      p25Ms: medianS * 900,
      p75Ms: medianS * 1150,
      p90Ms: medianS * 1300,
      waitMs: 6000,
      trend: null,
    };
  };
  // `runs` over 14 days, scaled to the window and spread over weekdays.
  const minutes = (medianS: number, runs14: number, quota: boolean): Minutes => {
    const runs = Math.max(1, Math.round((runs14 * days) / 14));
    const dailyMs = Array.from({ length: days }, () => 0);
    let quotaMinutes = 0;
    let runMs = 0;
    const today = new Date().getUTCDay();
    for (let i = 0; i < runs; i += 1) {
      let day = Math.floor(random() * days);
      const weekday = (today - (days - 1 - day) + 7 * 10) % 7;
      if ((weekday === 0 || weekday === 6) && random() < 0.7) day = Math.floor(random() * days);
      const ms = Math.round(medianS * 1000 * Math.exp((random() - 0.5) * 0.5));
      dailyMs[day] = (dailyMs[day] ?? 0) + ms;
      runMs += ms;
      if (quota) quotaMinutes += Math.max(1, Math.ceil(ms / 60_000));
    }
    return { runs, runMs, quotaMinutes, dailyMs };
  };
  const linux = "github:linux-2-core";
  const mac = "machine:sample";
  const selfHosted = "self-hosted:Default";
  const blacksmith = "blacksmith:blacksmith-2vcpu-ubuntu-2404";
  const container = "container";
  type Spec = Record<string, [medianS: number, runs: number]>;
  const job = (name: string, spec: Spec, isPrivate: boolean): JobRow => ({
    name,
    byEnvironment: Object.fromEntries(
      Object.entries(spec).map(([key, [medianS, runs]]) => [key, stat(medianS, runs)]),
    ),
    minutes: Object.fromEntries(
      Object.entries(spec).map(([key, [medianS, runs]]) => [
        key,
        minutes(medianS, runs, isPrivate && key.startsWith("github:")),
      ]),
    ),
  });
  const workflow = (
    repository: string,
    name: string,
    isPrivate: boolean,
    jobs: [string, Spec][],
  ): WorkflowRow => ({
    repositoryId: repository.length,
    repository,
    workflow: name,
    private: isPrivate,
    byEnvironment: {},
    jobs: jobs.map(([jobName, spec]) => job(jobName, spec, isPrivate)),
  });
  const workflows = [
    workflow("acme/app", "CI", true, [
      ["test", { [mac]: [250, 52], [linux]: [360, 21], [blacksmith]: [220, 12] }],
      ["build", { [mac]: [95, 50], [linux]: [140, 18] }],
      ["lint", { [linux]: [12, 14], [container]: [30, 5] }],
    ]),
    workflow("acme/app", "Release", true, [["build-macos", { [selfHosted]: [235, 4] }]]),
    workflow("acme/website", "CI", false, [
      ["Lint, type-check, and test", { [blacksmith]: [78, 118], [linux]: [131, 9] }],
    ]),
  ];
  const environments: EnvironmentSummary[] = [
    {
      key: mac,
      label: "Zach's MacBook Pro",
      detail: "MacBook Pro · Apple M3 Max",
      kind: "machine",
    },
    { key: blacksmith, label: "blacksmith-2vcpu-ubuntu-2404", detail: "Blacksmith", kind: "cloud" },
    { key: linux, label: "Linux 2-core", detail: "GitHub-hosted", kind: "github" },
    { key: container, label: "Cloudflare Container", detail: "standard-1", kind: "cloud" },
    { key: selfHosted, label: "Self-hosted", detail: "Default", kind: "machine" },
  ].map((env) => ({ ...env, kind: env.kind as EnvironmentKind, stat: stat(60, 10), versus: null }));
  return { days, sampleCap: 50, baseline: linux, environments, workflows };
}

/** A sample billing cycle for dev builds. */
export function sampleActionsUsage(): { accounts: AccountMinutes[] } {
  return {
    accounts: [
      {
        installationId: 1,
        accountLogin: "acme",
        status: "ok",
        quotaMinutes: 2000,
        usedMinutes: 1184,
      },
    ],
  };
}
