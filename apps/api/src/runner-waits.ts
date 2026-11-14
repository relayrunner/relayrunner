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
import { RATES } from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { WAIT_BUCKETS } from "./db/schema.ts";
import { environmentFor, environmentProvider } from "./job-times.ts";

const table = schema.runnerWaitDay;
const DAY_MS = 86_400_000;

// Who runs a job but isn't a hosted runner anyone could pick for a comparison.
const NOT_HOSTED = new Set(["machine", "self-hosted", "other", "container"]);

export type RunnerPlatform = "linux" | "arm" | "windows" | "windows-arm" | "macos" | "other";

export interface WaitRunner {
  provider: string;
  platform: RunnerPlatform;
  vcpus: number;
}

/** The hosted runner a job asked for, as runner_wait_day keys it, or null for any other runner. */
export function waitRunner(labels: string[], runnerGroupName: string | null): WaitRunner | null {
  const env = environmentFor(labels, runnerGroupName, null);
  const provider = environmentProvider(env);
  if (NOT_HOSTED.has(provider)) return null;
  const label = env.key.slice(provider.length + 1);
  // A GitHub larger runner is named by whoever made it, so its name says nothing reliable.
  const named = provider === "github" && !Object.hasOwn(RATES.github, label);
  return {
    provider,
    platform: named ? "other" : platformOf(label),
    vcpus: env.size?.vcpus ?? 0,
  };
}

function platformOf(label: string): RunnerPlatform {
  const lower = label.toLowerCase();
  const arm = /arm|aarch64/.test(lower);
  if (/macos|xcode/.test(lower)) return "macos";
  if (lower.includes("windows")) return arm ? "windows-arm" : "windows";
  if (arm) return "arm";
  // Ubicloud's standard and premium runners are Linux x64.
  if (/ubuntu|linux|x64|amd64|standard|premium/.test(lower)) return "linux";
  return "other";
}

/** The wait bucket column a wait lands in. */
export function waitBucket(waitMs: number): keyof typeof WAIT_BUCKETS {
  const entries = Object.entries(WAIT_BUCKETS) as [keyof typeof WAIT_BUCKETS, number][];
  return entries.find(([, under]) => waitMs < under)![0];
}

export interface FinishedJob {
  installationId: number;
  labels: string[];
  runnerGroupName: string | null;
  // Null when no runner ever took the job (cancelled while queued).
  runnerName: string | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date;
  // False when the runner failed the job before any of its steps started.
  ranSteps: boolean | null;
  conclusion: string | null;
}

/** Adds a job that just finished to its runner's day, when a hosted runner took it. */
export async function countRunnerWait(db: Db, job: FinishedJob) {
  if (!job.runnerName || !job.queuedAt || !job.startedAt) return;
  const runner = waitRunner(job.labels, job.runnerGroupName);
  if (!runner) return;
  const waitMs = Math.max(0, job.startedAt.getTime() - job.queuedAt.getTime());
  const bucket = waitBucket(waitMs);
  const failed = job.ranSteps === false && job.conclusion === "failure" ? 1 : 0;
  await db
    .insert(table)
    .values({
      day: new Date(Math.floor(job.completedAt.getTime() / DAY_MS) * DAY_MS),
      ...runner,
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
