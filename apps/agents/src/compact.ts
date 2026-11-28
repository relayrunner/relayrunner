import {
  dollars,
  type ActivityItem,
  type ActivityPage,
  type ActivityStarter,
  type RouteWalk,
} from "@relayrunner/activity";
import type { JobRow, PerformanceReport, Stat } from "@relayrunner/api-types";

// Agent clients cap tool results (Claude Code's is about 25k tokens), and the dashboard's answers
// carry everything a page might render. These cut them down to what an agent reasons over.

const starterName = (starter: ActivityStarter | null | undefined) =>
  starter ? (starter.member?.name ?? starter.login) : undefined;

// Where the walk ended and why earlier steps passed, without the relay's raw label inputs.
function route(walk: RouteWalk | null) {
  if (!walk) return undefined;
  return {
    step: walk.step,
    // Every skip's own fields pass through, with the bulky ones cut to what an agent reads.
    skipped: walk.skipped.map(({ notShared, minutes, spend, ...skip }) => ({
      ...skip,
      ...(notShared && { notShared: notShared.map((machine) => machine.machine) }),
      ...(minutes && { minutes: `${minutes.usedMinutes}/${minutes.quotaMinutes}` }),
      ...(spend && { spend: `${dollars(spend.spentUsd)}/${dollars(spend.limitUsd)}` }),
    })),
  };
}

/**
 * One activity entry for an agent: what happened, when, where and how it ended. `detail` keeps the
 * full entry (urls, sha, starters, the walk's label inputs).
 */
export function compactActivityItem(item: ActivityItem) {
  const base = {
    id: item.id,
    type: item.type,
    time: item.occurredAt,
    ...(item.actor && { actor: item.actor.name }),
  };
  if (item.type === "job.routed" && item.job) {
    const { job } = item;
    return {
      ...base,
      repo: job.repository,
      workflow: job.workflow,
      job: job.name,
      runId: job.runId,
      runner: job.runner.type === "machine" ? job.runner.name : job.runner.label,
      runnerName: job.runnerName,
      status: job.status,
      conclusion: job.conclusion,
      route: route(job.walk),
      startedBy: starterName(item.job.starters.startedBy),
    };
  }
  if (item.type === "job.unroutable") {
    const { data } = item;
    return {
      ...base,
      repo: data.repository,
      workflow: data.workflow,
      job: data.job,
      runId: data.runId,
      reason: data.reason,
      route: route(data.walk),
      jobsNotRun: item.jobsNotRun,
      startedBy: starterName(item.starters?.startedBy),
    };
  }
  if (item.type === "check.completed") {
    const { check, repository, pullRequest, conclusion } = item.data;
    return { ...base, repo: repository, check, pullRequest, conclusion };
  }
  return { ...base, ...(item.machine && { machine: item.machine.name }), ...item.data };
}

/**
 * The first `limit` entries of a page. When that cuts the page short, nextBefore points just past
 * the last entry kept (the API pages by event id), so the next call picks up there.
 */
export function compactActivityPage(page: ActivityPage, limit: number, detail: boolean) {
  const items = page.items.slice(0, limit);
  const cut = items.length < page.items.length;
  return {
    items: detail ? items : items.map(compactActivityItem),
    nextBefore: cut ? items[items.length - 1].id : page.nextBefore,
  };
}

const sampled = (byEnvironment: Record<string, Stat>) =>
  Object.fromEntries(Object.entries(byEnvironment).filter(([, stat]) => stat.samples > 0));

function sampledJob(job: JobRow): JobRow {
  return {
    ...job,
    byEnvironment: sampled(job.byEnvironment),
    ...(job.legs && { legs: job.legs.map(sampledJob) }),
  };
}

/** Whether `value` contains `part`, ignoring case; true when no part is asked for. */
export const contains = (value: string | null, part: string | undefined) =>
  !part || (value ?? "").toLowerCase().includes(part.toLowerCase());

/**
 * Job times narrowed to the workflows asked for, without times that have no successful runs behind
 * them, and without the environments nothing left ran on.
 */
export function compactJobTimes(
  report: PerformanceReport,
  { repository, workflow }: { repository?: string; workflow?: string },
) {
  const workflows = report.workflows
    .filter((row) => contains(row.repository, repository) && contains(row.workflow, workflow))
    .map((row) => ({
      ...row,
      jobs: row.jobs.map(sampledJob).filter((job) => Object.keys(job.byEnvironment).length > 0),
    }))
    .filter((row) => row.jobs.length > 0);
  const used = new Set<string>();
  const collect = (rows: JobRow[]) => {
    for (const row of rows) {
      for (const key of Object.keys(row.byEnvironment)) used.add(key);
      if (row.legs) collect(row.legs);
    }
  };
  for (const row of workflows) collect(row.jobs);
  return {
    ...report,
    environments: report.environments.filter((env) => env.stat.samples > 0 && used.has(env.key)),
    workflows,
  };
}

// The Providers pages' answers (apps/api/src/reports/provider-report.ts, provider-trends.ts and
// route-outcomes.ts), declared with only the fields these read: the rest passes through as the
// dashboard has it.

interface ProviderCounts {
  waits: number;
  quickStarts: number;
}

type Percentiles = Record<"p50" | "p90" | "p99", number> | null;

export interface ProvidersAnswer {
  days: number;
  providers: (ProviderCounts & { provider: string; stat: Stat; runners: unknown[] })[];
}

export interface RouteOutcomesAnswer {
  runs: number;
  first: number;
  movedOn: number;
  waited: number;
  failed: number;
  reasons: unknown[];
}

export interface ProviderAnswer extends ProviderCounts {
  stat: Stat;
  /** List prices with their history, which perMinute on each runner type already gives. */
  prices: unknown[];
  runners: (ProviderCounts & { key: string; stat: Stat })[];
}

export interface ProviderTrendsAnswer {
  bucketMs: number;
  runners: {
    key: string;
    points: {
      start: number;
      jobs: number;
      runnerFailures: number;
      wait: Percentiles;
      run: Percentiles;
    }[];
  }[];
}

const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 1000));

const secondsAt = (p: Percentiles) =>
  p && { p50: seconds(p.p50), p90: seconds(p.p90), p99: seconds(p.p99) };

/** Counts with the share of jobs started within a minute instead of the two counts behind it. */
function counts<T extends ProviderCounts>({ waits, quickStarts, ...rest }: T) {
  return {
    ...rest,
    startedWithinMinute: waits ? Math.round((quickStarts / waits) * 100) / 100 : null,
  };
}

/** A Stat's times in seconds, and how many successful runs they come from. */
const times = (stat: Stat) => ({
  medianSeconds: seconds(stat.medianMs),
  p90Seconds: seconds(stat.p90Ms),
  waitSeconds: seconds(stat.waitMs),
  samples: stat.samples,
});

/** Every provider in the window, and how the Router's routed runs went. */
export function compactProviders(overview: ProvidersAnswer, outcomes: RouteOutcomesAnswer) {
  const { runs, first, movedOn, waited, failed, reasons } = outcomes;
  return {
    days: overview.days,
    providers: overview.providers.map(({ stat, runners, ...provider }) => ({
      ...counts(provider),
      ...times(stat),
      runnerTypes: runners.length,
    })),
    routerOutcomes: { runs, first, movedOn, waited, failed, reasons },
  };
}

/** One provider's runner types, with their queue wait and job time percentiles over time. */
export function compactProvider(report: ProviderAnswer, trends: ProviderTrendsAnswer) {
  const byKey = new Map(trends.runners.map((runner) => [runner.key, runner.points]));
  const { stat, runners, prices: _, ...rest } = report;
  return {
    ...counts(rest),
    ...times(stat),
    bucket: trends.bucketMs >= 7 * 86_400_000 ? "week" : "day",
    runners: runners.map(({ stat, ...runner }) => {
      // Only the busiest few runner types have charts.
      const points = byKey.get(runner.key);
      return {
        ...counts(runner),
        ...times(stat),
        ...(points && {
          overTime: points.map((point) => ({
            date: new Date(point.start).toISOString().slice(0, 10),
            jobs: point.jobs,
            runnerFailures: point.runnerFailures,
            waitSeconds: secondsAt(point.wait),
            runSeconds: secondsAt(point.run),
          })),
        }),
      };
    }),
  };
}
