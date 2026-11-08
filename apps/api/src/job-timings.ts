import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { routingLabelFromLabels } from "./github-runners.ts";
import { findInstallation } from "./installations.ts";
import { parseDate } from "./jobs.ts";
import { routeIdFromLabels } from "./routing.ts";

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;

const table = schema.jobTiming;
export const DAY_MS = 86_400_000;

// GitHub bills a job by the minute, rounded up. A job that finishes in under this is the free-checks
// opportunity: it pays for a whole minute however little of it ran.
export const SHORT_JOB_SECONDS = 60;

/**
 * Which per-minute rate a job pays. GitHub-hosted classes follow the standard runner price list;
 * `self-hosted` covers a self-hosted runner (including RelayRunner's own picks and machines), which
 * GitHub doesn't charge for. `other` is a label we can't price, such as a larger runner, and is
 * counted at the Linux 2-core rate, so the estimate is a floor.
 */
export type RunnerClass =
  | "linux-1-core"
  | "linux-2-core"
  | "windows-2-core"
  | "macos"
  | "self-hosted"
  | "other";

// USD per minute for a private repo, as of Nov 2026. Standard GitHub-hosted runners are free in
// public repos.
export const RUNNER_RATES: Record<RunnerClass, { label: string; perMinute: number }> = {
  "linux-1-core": { label: "Linux 1-core", perMinute: 0.002 },
  "linux-2-core": { label: "Linux 2-core", perMinute: 0.006 },
  "windows-2-core": { label: "Windows 2-core", perMinute: 0.01 },
  macos: { label: "macOS", perMinute: 0.062 },
  "self-hosted": { label: "Self-hosted", perMinute: 0 },
  other: { label: "Other (priced as Linux 2-core)", perMinute: 0.006 },
};

/**
 * What a minute costs on a runner class in a repo: standard runners are free in public repos, and
 * unknown visibility counts as private, so a missing mirror row never hides a cost.
 */
export function rateFor(cls: RunnerClass, isPrivate: boolean | null | undefined) {
  return isPrivate === false ? 0 : RUNNER_RATES[cls].perMinute;
}

const GITHUB_HOSTED_GROUP = "GitHub Actions";

/**
 * Classifies a job by its runs-on labels and, once a runner took it, the runner's group. Applied when
 * the report is read, so changing the rules or the rates needs no backfill.
 */
export function runnerClass(labels: string[], runnerGroupName?: string | null): RunnerClass {
  const lower = labels.map((label) => label.toLowerCase());
  // A pick (`runs-on: relayrunner`) or a route's machine is self-hosted too.
  if (lower.includes("self-hosted") || lower.includes("relayrunner") || routeIdFromLabels(labels))
    return "self-hosted";
  // A runner group other than GitHub's own means the org's runners, unless the labels name a hosted
  // image (larger hosted runners can sit in custom groups).
  const hosted = lower.find((label) => /^(ubuntu|windows|macos)-/.test(label));
  if (!hosted)
    return runnerGroupName && runnerGroupName !== GITHUB_HOSTED_GROUP ? "self-hosted" : "other";
  if (hosted.startsWith("macos")) return "macos";
  if (hosted.startsWith("windows"))
    return /^windows-(latest|\d{4})$/.test(hosted) ? "windows-2-core" : "other";
  if (hosted === "ubuntu-slim") return "linux-1-core";
  if (/^ubuntu-(latest|\d{2}\.\d{2})(-arm)?$/.test(hosted)) return "linux-2-core";
  return "other";
}

/**
 * Stores a finished job's timing, for every job in a connected repo, whoever's runner it asked
 * for. Only `completed` is kept: it carries both the start and finish, so earlier actions would only
 * add writes. A redelivery is a no-op. Skipped when the installation has no row yet.
 */
export async function recordJobTiming(db: Db, message: WorkflowJobMessage): Promise<boolean> {
  const { installationId, job, repository } = message;
  if (job.status !== "completed") return false;
  if (!installationId || !(await findInstallation(db, installationId))) return false;
  await db
    .insert(table)
    .values({
      id: job.id,
      installationId,
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      runId: job.runId,
      runAttempt: job.runAttempt,
      workflowName: job.workflowName,
      name: job.name,
      labels: job.labels,
      conclusion: job.conclusion,
      runnerName: job.runnerName,
      runnerGroupName: job.runnerGroupName ?? null,
      machineId: routedMachine(job.id, job.labels),
      queuedAt: parseDate(job.createdAt),
      startedAt: parseDate(job.startedAt),
      completedAt: parseDate(job.completedAt),
    })
    .onConflictDoNothing({ target: table.id });
  return true;
}

/**
 * The machine a route sent the job to, when the job ran on a route's or an added runner's label:
 * read from its workflow_job row by primary key inside the insert, so it costs no extra round
 * trip. setJobMachine fills it in when that row learns its machine after this one was written.
 */
function routedMachine(jobId: number, labels: string[]) {
  if (!routeIdFromLabels(labels) && !routingLabelFromLabels(labels)) return null;
  return sql<
    string | null
  >`(select ${schema.workflowJob.machineId} from ${schema.workflowJob} where ${schema.workflowJob.id} = ${jobId})`;
}

// How long job timings are kept. The report's longest range is 90 days.
export const JOB_TIMING_RETENTION_DAYS = 90;
// Rows deleted per statement, so one purge never runs long. The hourly cron catches up on the rest.
const PURGE_BATCH = 5_000;

/** Deletes job timings older than the retention window. Returns how many rows went. */
export async function purgeOldJobTimings(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - JOB_TIMING_RETENTION_DAYS * DAY_MS);
  let deleted = 0;
  for (let i = 0; i < 10; i += 1) {
    const result = await db
      .delete(table)
      .where(
        inArray(
          table.id,
          db
            .select({ id: table.id })
            .from(table)
            .where(lt(table.completedAt, cutoff))
            .limit(PURGE_BATCH),
        ),
      );
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < PURGE_BATCH) break;
  }
  return deleted;
}

// The per-job sums a report row carries, all starting at zero.
const COUNTERS = [
  "jobs",
  "shortJobs",
  "runSeconds",
  "billedMinutes",
  "shortBilledMinutes",
  "cost",
  "shortCost",
  "roundingCost",
] as const;
type Counters = Record<(typeof COUNTERS)[number], number>;

export interface UsageRow extends Counters {
  runnerClass: RunnerClass;
  label: string;
  /** USD per minute in a private repo. */
  perMinute: number;
}

export interface UsageReport {
  days: number;
  shortJobSeconds: number;
  /**
   * runSeconds: time the jobs ran. billedMinutes: after rounding each job up. shortBilledMinutes:
   * the billed minutes of jobs under a minute. cost, shortCost: estimated USD after free
   * public-repo minutes. roundingCost: what rounding up added on top of the time run.
   */
  totals: Counters;
  byRunner: UsageRow[];
  /** Repos with the most short-job cost first. */
  byRepository: {
    repository: string;
    private: boolean | null;
    jobs: number;
    shortJobs: number;
    shortCost: number;
  }[];
}

/**
 * The workspace's finished jobs from the last `days` days: how many ran under a minute, and what
 * GitHub's round-up cost. Counts only jobs a runner ran (not skipped, not cancelled while queued).
 * Sums are grouped by the columns runnerClass reads, so classification happens per group, not per
 * job.
 */
export async function usageReport(db: Db, workspaceId: string, days = 30): Promise<UsageReport> {
  const since = new Date(Date.now() - days * DAY_MS);
  const durationMs = sql`max(0, ${table.completedAt} - ${table.startedAt})`;
  const billed = sql`max(1, (${durationMs} + 59999) / 60000)`;
  const isShort = sql`(${durationMs} < ${SHORT_JOB_SECONDS * 1000})`;
  const rows = await db
    .select({
      labels: table.labels,
      runnerGroupName: table.runnerGroupName,
      repository: table.repositoryFullName,
      private: schema.githubRepository.private,
      jobs: sql<number>`count(*)`,
      shortJobs: sql<number>`sum(${isShort})`,
      runMs: sql<number>`sum(${durationMs})`,
      billedMinutes: sql<number>`sum(${billed})`,
      shortBilledMinutes: sql<number>`sum(case when ${isShort} then ${billed} else 0 end)`,
    })
    .from(table)
    .innerJoin(schema.githubInstallation, eq(schema.githubInstallation.id, table.installationId))
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, table.repositoryId))
    .where(
      and(
        eq(schema.githubInstallation.workspaceId, workspaceId),
        gte(table.completedAt, since),
        isNotNull(table.startedAt),
        isNotNull(table.runnerName),
        ne(sql`coalesce(${table.conclusion}, '')`, "skipped"),
      ),
    )
    .groupBy(
      table.labels,
      table.runnerGroupName,
      table.repositoryFullName,
      schema.githubRepository.private,
    );

  const totals = zero();
  const byRunner = new Map<RunnerClass, UsageRow>();
  const byRepository = new Map<string, UsageReport["byRepository"][number]>();
  for (const row of rows) {
    const cls = runnerClass(row.labels, row.runnerGroupName);
    const perMinute = rateFor(cls, row.private);
    const runSeconds = Number(row.runMs) / 1000;
    const billedMinutes = Number(row.billedMinutes);
    const shortBilledMinutes = Number(row.shortBilledMinutes);
    const sums: Counters = {
      jobs: Number(row.jobs),
      shortJobs: Number(row.shortJobs),
      runSeconds,
      billedMinutes,
      shortBilledMinutes,
      cost: billedMinutes * perMinute,
      shortCost: shortBilledMinutes * perMinute,
      roundingCost: (billedMinutes - runSeconds / 60) * perMinute,
    };
    add(totals, sums);
    const runner = byRunner.get(cls) ?? {
      runnerClass: cls,
      label: RUNNER_RATES[cls].label,
      perMinute: RUNNER_RATES[cls].perMinute,
      ...zero(),
    };
    add(runner, sums);
    byRunner.set(cls, runner);

    const repo = byRepository.get(row.repository) ?? {
      repository: row.repository,
      private: row.private ?? null,
      jobs: 0,
      shortJobs: 0,
      shortCost: 0,
    };
    repo.jobs += sums.jobs;
    repo.shortJobs += sums.shortJobs;
    repo.shortCost += sums.shortCost;
    byRepository.set(row.repository, repo);
  }

  return {
    days,
    shortJobSeconds: SHORT_JOB_SECONDS,
    totals: rounded(totals),
    byRunner: [...byRunner.values()]
      .map(rounded)
      .sort((a, b) => b.shortCost - a.shortCost || b.jobs - a.jobs),
    byRepository: [...byRepository.values()]
      .map((repo) => ({ ...repo, shortCost: cents(repo.shortCost) }))
      .sort((a, b) => b.shortCost - a.shortCost || b.shortJobs - a.shortJobs)
      .slice(0, 10),
  };
}

function zero(): Counters {
  return Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Counters;
}

function add(into: Counters, sums: Counters) {
  for (const key of COUNTERS) into[key] += sums[key];
}

// Keeps sub-cent precision (a 1-core minute is $0.002) without float noise.
export function cents(value: number) {
  return Math.round(value * 1000) / 1000;
}

function rounded<T extends Counters>(row: T): T {
  return {
    ...row,
    cost: cents(row.cost),
    shortCost: cents(row.shortCost),
    roundingCost: cents(row.roundingCost),
    runSeconds: Math.round(row.runSeconds),
  };
}
