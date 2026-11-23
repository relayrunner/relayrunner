// One runner's report for the dev preview (lib/sample/answers.ts), like GET /api/job-times/runner.
import { DAY_MS, HOUR_MS } from "../job-times";
import type { RunnerBucket } from "../runner-days.ts";
import { zoneParts } from "../time-zone";
import { type RunnerReport, utcOffset } from "../runner-report.ts";
import { sampleJobTimes } from "./job-times.ts";
import { sampleRunInfo } from "./runs.ts";
import { seededRandom } from "./shared.ts";

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
  const random = seededRandom(key.length * 7 + 3);
  const median = stat.medianMs ?? 60_000;
  const span = to - from;
  // As the API's bucketFor cuts them.
  const bucketMs = span <= 6 * HOUR_MS ? 900_000 : span <= 2 * DAY_MS + HOUR_MS ? HOUR_MS : DAY_MS;
  const offsetMs = utcOffset() * 60_000;
  const buckets: RunnerBucket[] = [];
  for (
    let start = Math.floor((from + offsetMs) / bucketMs) * bucketMs - offsetMs;
    start < to;
    start += bucketMs
  ) {
    // Busy in working hours on weekdays, quiet at night and at weekends.
    const { hour, weekday } = zoneParts(start);
    const busy =
      (weekday % 6 === 0 ? 0.5 : 1) *
      (bucketMs === DAY_MS ? 14 : hour >= 9 && hour < 19 ? (bucketMs === HOUR_MS ? 6 : 2) : 0.4);
    const jobs = Math.round(random() * busy);
    const failures = jobs && random() > 0.8 ? 1 : 0;
    buckets.push({ start, jobs, failures, busyMs: jobs * median });
  }
  const names = ["lint", "test (node 24)", "build", "typecheck", "e2e"];
  const recent = Array.from({ length: 12 }, (_, index) => {
    const completedAt = to - (index * span) / 14 - random() * (span / 14);
    const runMs = median * (0.7 + random() * 0.6);
    const startedAt = completedAt - runMs;
    // A few jobs to a run, as a workflow's jobs share one.
    const runId = 500 + Math.floor(index / 3);
    return {
      id: 1000 + index,
      runId,
      runAttempt: 1,
      ...sampleRunInfo(runId),
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
