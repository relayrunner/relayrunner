import { api } from "@/lib/api";
import { DAY_MS, type Environment, sampleJobTimes, type Stat } from "@/lib/job-times";
import { midnight, type RunnerDay } from "./runner-days.ts";
import type { HistoryJob } from "./runs.ts";

export type RunnerJob = Omit<HistoryJob, "usage">;

/** One runner over a window (GET /api/job-times/runner), for its detail panel. */
export type RunnerReport = {
  days: number;
  environment: Environment;
  stat: Stat;
  /** Jobs sent here that no runner picked up within 10 minutes. */
  missed: number;
  /** Days with jobs, oldest first, cut at the reader's midnight. */
  daily: RunnerDay[];
  /** Newest first. */
  recent: RunnerJob[];
  /** A connected machine's connections in the window, oldest first; null for any other runner. */
  connections: { at: number; online: boolean }[] | null;
};

export function getRunnerReport(key: string, days: number) {
  const query = new URLSearchParams({
    key,
    days: String(days),
    utcOffset: String(-new Date().getTimezoneOffset()),
  });
  return api<RunnerReport>(`/job-times/runner?${query}`);
}

/** Dev preview: a made-up report for any of the sample reports' runners. */
export function sampleRunnerReport(key: string, days: number): RunnerReport {
  const sample = sampleJobTimes(days);
  const env = sample.environments.find((each) => each.key === key);
  const {
    missed = 0,
    stat,
    ...environment
  } = env ?? {
    key,
    label: key.slice(key.indexOf(":") + 1),
    detail: "",
    stat: sample.environments[0]!.stat,
  };
  const now = Date.now();
  let seed = key.length * 7 + 3;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const median = stat.medianMs ?? 60_000;
  const daily = Array.from({ length: days }, (_, index) => {
    const jobs = Math.round(random() * 14 * (index % 7 < 5 ? 1 : 0.2));
    return {
      day: midnight(days - 1 - index, now),
      jobs,
      failures: random() > 0.75 ? 1 : 0,
      busyMs: jobs * median,
    };
  }).filter((day) => day.jobs > 0);
  const names = ["lint", "test (node 24)", "build", "typecheck", "e2e"];
  const recent = Array.from({ length: 12 }, (_, index) => {
    const completedAt = now - (index * 3 + random() * 3) * 3_600_000;
    const runMs = median * (0.7 + random() * 0.6);
    const startedAt = completedAt - runMs;
    return {
      id: 1000 + index,
      runId: 500 + index,
      runAttempt: 1,
      environment: key,
      conclusion: random() > 0.9 ? "failure" : "success",
      queuedAt: startedAt - random() * 20_000,
      startedAt,
      completedAt,
      repositoryId: 1,
      repository: "acme/app",
      workflow: "CI",
      name: names[index % names.length]!,
    };
  });
  const connections = key.startsWith("machine:sample")
    ? [
        { at: now - (days - 2) * DAY_MS, online: true },
        { at: now - (days - 5) * DAY_MS, online: false },
        { at: now - (days - 6) * DAY_MS, online: true },
        { at: now - 3 * DAY_MS, online: false },
        { at: now - 2 * DAY_MS - 3_600_000, online: true },
      ]
    : null;
  return {
    days,
    environment,
    stat,
    missed,
    daily,
    recent,
    connections,
  };
}
