/**
 * How long jobs waited for a hosted runner, kept per UTC day in runner_wait_day so a public
 * comparison of runners (#492) can later report each runner's median wait and the share of jobs
 * started within a minute, over any range and long after job_timing drops single jobs.
 *
 * Each job is counted once, when job_timing first records it finished (src/job-timings.ts). Only
 * GitHub-hosted runners and hosted providers count: a runner is kept as its provider, platform and
 * vCPUs, never its label, since labels can carry names people chose (Namespace profiles, larger
 * runners) or run ids (RunsOn). Self-hosted runners and machines aren't counted.
 */
import { labelOfEnvironment, runnerPlatform, type RunnerSize } from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { WAIT_BUCKETS } from "./db/schema.ts";
import { environmentFor, environmentProvider } from "./job-times.ts";
import { utcDay } from "./job-timings.ts";

const table = schema.runnerWaitDay;

// Who runs a job but isn't a hosted runner anyone could pick for a comparison.
const NOT_HOSTED = new Set(["machine", "self-hosted", "other", "container"]);

/** The hosted runner a job ran on: its provider (`github` or a hosted provider) and label. */
export interface HostedRunner {
  provider: string;
  // For GitHub, the standard runner's rate (`linux-2-core`), else the label itself.
  label: string;
  size?: RunnerSize;
}

/** The hosted runner a job asked for, or null for a machine or a runner people host themselves. */
export function hostedRunner(
  labels: string[],
  runnerGroupName: string | null,
): HostedRunner | null {
  const env = environmentFor(labels, runnerGroupName, null);
  const provider = environmentProvider(env);
  if (NOT_HOSTED.has(provider)) return null;
  return { provider, label: labelOfEnvironment(env.key), size: env.size };
}

/** A job that just finished, as the rollups in this file and src/provider-spend.ts read it. */
export interface FinishedJob {
  installationId: number;
  runner: HostedRunner | null;
  // Null when no runner ever took the job (cancelled while queued).
  runnerName: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date;
  // False when the runner failed the job before any of its steps started.
  ranSteps: boolean | null;
  conclusion: string | null;
}

/** runner_wait_day's key for a hosted runner: never its label, which can be someone's own name. */
export function waitKey({ provider, label, size }: HostedRunner) {
  return {
    provider,
    platform: runnerPlatform(provider, label) ?? "other",
    vcpus: size?.vcpus ?? 0,
  };
}

const BUCKETS = Object.entries(WAIT_BUCKETS) as [keyof typeof WAIT_BUCKETS, number][];

/** The wait bucket column a wait lands in. */
export function waitBucket(waitMs: number): keyof typeof WAIT_BUCKETS {
  return BUCKETS.find(([, under]) => waitMs < under)![0];
}

/** The upsert adding a finished job to its runner's day, or null when it doesn't count. */
export function runnerWaitUpsert(db: Db, job: FinishedJob) {
  if (!job.runner || !job.runnerName || !job.queuedAt || !job.startedAt) return null;
  const waitMs = Math.max(0, job.startedAt.getTime() - job.queuedAt.getTime());
  const bucket = waitBucket(waitMs);
  const failed = job.ranSteps === false && job.conclusion === "failure" ? 1 : 0;
  return db
    .insert(table)
    .values({
      day: new Date(utcDay(job.completedAt.getTime())),
      ...waitKey(job.runner),
      installationId: job.installationId,
      jobs: 1,
      waitMs,
      [bucket]: 1,
      runnerFailures: failed,
    })
    .onConflictDoUpdate({
      target: [table.day, table.provider, table.platform, table.vcpus, table.installationId],
      set: {
        jobs: sql`${table.jobs} + 1`,
        waitMs: sql`${table.waitMs} + ${waitMs}`,
        [bucket]: sql`${table[bucket]} + 1`,
        runnerFailures: sql`${table.runnerFailures} + ${failed}`,
      },
    });
}
