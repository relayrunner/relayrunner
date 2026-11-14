import { api } from "@/lib/api";
import { DAY_MS, type Environment, sampleJobTimes, type Stat } from "@/lib/job-times";
import type { RunnerBucket } from "./runner-days.ts";
import type { HistoryJob } from "./runs.ts";

const HOUR_MS = DAY_MS / 24;

export type RunnerJob = Omit<HistoryJob, "usage">;

/** One runner over a window (GET /api/job-times/runner), for its detail panel. */
export type RunnerReport = {
  /** The window, in epoch ms. */
  from: number;
  to: number;
  /** How long each bar spans: 15 minutes, an hour or a day, by how long the window is. */
  bucketMs: number;
  environment: Environment;
  stat: Stat;
  /** Jobs sent here that no runner picked up within 10 minutes. */
  missed: number;
  /** Bars with jobs, oldest first, cut at the reader's midnight and hours. */
  buckets: RunnerBucket[];
  /** Newest first. */
  recent: RunnerJob[];
  /** A connected machine's connections in the window, oldest first; null for any other runner. */
  connections: { at: number; online: boolean }[] | null;
};

/** The reader's minutes east of UTC, which bars are cut at. */
export const utcOffset = () => -new Date().getTimezoneOffset();

export function getRunnerReport(key: string, { from, to }: { from: number; to: number }) {
  const query = new URLSearchParams({
    key,
    from: String(from),
    to: String(to),
    utcOffset: String(utcOffset()),
  });
  return api<RunnerReport>(`/job-times/runner?${query}`);
}

/** Dev preview: a made-up report for any of the sample reports' runners. */
export function sampleRunnerReport(
  key: string,
  { from, to }: { from: number; to: number },
): RunnerReport {
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
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
  const now = to;
  let seed = key.length * 7 + 3;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const median = stat.medianMs ?? 60_000;
  const span = to - from;
  const bucketMs = span <= 6 * HOUR_MS ? 900_000 : span <= 2 * DAY_MS + HOUR_MS ? HOUR_MS : DAY_MS;
  const offsetMs = utcOffset() * 60_000;
  const buckets: RunnerBucket[] = [];
  for (
    let start = Math.floor((from + offsetMs) / bucketMs) * bucketMs - offsetMs;
    start < to;
    start += bucketMs
  ) {
    // Busy in working hours on weekdays, quiet at night and at weekends.
    const date = new Date(start);
    const hour = date.getHours();
    const busy =
      (date.getDay() % 6 === 0 ? 0.5 : 1) *
      (bucketMs === DAY_MS ? 14 : hour >= 9 && hour < 19 ? (bucketMs === HOUR_MS ? 6 : 2) : 0.4);
    const jobs = Math.round(random() * busy);
    if (jobs)
      buckets.push({ start, jobs, failures: random() > 0.8 ? 1 : 0, busyMs: jobs * median });
  }
  const names = ["lint", "test (node 24)", "build", "typecheck", "e2e"];
  const recent = Array.from({ length: 12 }, (_, index) => {
    const completedAt = now - (index * span) / 14 - random() * (span / 14);
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
        { at: from + span * 0.1, online: true },
        { at: from + span * 0.35, online: false },
        { at: from + span * 0.42, online: true },
        { at: from + span * 0.7, online: false },
        { at: from + span * 0.78, online: true },
      ]
    : null;
  return {
    from,
    to,
    bucketMs,
    environment,
    stat,
    missed,
    buckets,
    recent,
    connections,
  };
}
