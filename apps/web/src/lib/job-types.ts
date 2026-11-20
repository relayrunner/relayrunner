import { api } from "@/lib/api";
import { DAY_MS, type JobType } from "./job-times.ts";
import { zoneOffset } from "./time-zone.ts";

/** One job's run time over the window (GET /api/job-times/types). */
export type JobTypeTime = {
  repository: string;
  workflow: string | null;
  /** A matrix job's legs are added up under their shared name. */
  job: string;
  /** Null until the AI model has read the job, or when it wasn't sure. */
  type: JobType | null;
  runs: number;
  ms: number;
  /** Run time in the window just as long before; null when timings don't go back that far. */
  priorMs: number | null;
  /** Run time on each day of the window, oldest first. */
  byDay: number[];
};

export type JobTypeTimes = {
  days: number;
  /** The first day's local midnight, in epoch ms. */
  start: number;
  /** Whether the AI model may read this workspace's jobs. */
  ai: boolean;
  /** Whether jobs carry priorMs. */
  compare: boolean;
  jobs: JobTypeTime[];
};

export function getJobTypeTimes(days: number) {
  const query = new URLSearchParams({
    days: String(days),
    utcOffset: String(zoneOffset(Date.now())),
  });
  return api<JobTypeTimes>(`/job-times/types?${query}`);
}

/** A type, or "none" for jobs not sorted yet. */
export type TypeKey = JobType | "none";

/** The order types stack and list in, which their colors were checked for. */
export const TYPE_ORDER: TypeKey[] = ["test", "build", "lint", "e2e", "deploy", "other", "none"];

export const typeColor = (key: TypeKey) => `var(--job-${key})`;

export type TypeTotal = {
  key: TypeKey;
  ms: number;
  runs: number;
  /** Null when the window before isn't known. */
  priorMs: number | null;
  /** Its jobs with runs, the most time first. */
  jobs: JobTypeTime[];
};

export type TypeSummary = {
  ms: number;
  runs: number;
  /** Types with time in the window, in TYPE_ORDER. */
  types: TypeTotal[];
  /** Each day's local midnight and its run time by type. */
  days: { start: number; ms: Partial<Record<TypeKey, number>> }[];
};

/** Adds the report's jobs up by type, for one repo or all of them. */
export function summarize(report: JobTypeTimes, repository = "all"): TypeSummary {
  const totals = new Map<TypeKey, TypeTotal>();
  const days = Array.from({ length: report.days }, (_, i) => ({
    start: report.start + i * DAY_MS,
    ms: {} as Partial<Record<TypeKey, number>>,
  }));
  for (const job of report.jobs) {
    if (repository !== "all" && job.repository !== repository) continue;
    const key = job.type ?? "none";
    let total = totals.get(key);
    if (!total) {
      total = { key, ms: 0, runs: 0, priorMs: report.compare ? 0 : null, jobs: [] };
      totals.set(key, total);
    }
    total.ms += job.ms;
    total.runs += job.runs;
    if (total.priorMs !== null) total.priorMs += job.priorMs ?? 0;
    if (job.runs > 0) total.jobs.push(job);
    job.byDay.forEach((ms, i) => {
      if (ms > 0 && days[i]) days[i].ms[key] = (days[i].ms[key] ?? 0) + ms;
    });
  }
  const types = TYPE_ORDER.flatMap((key) => {
    const total = totals.get(key);
    return total && total.ms > 0 ? [total] : [];
  });
  return {
    ms: types.reduce((sum, type) => sum + type.ms, 0),
    runs: types.reduce((sum, type) => sum + type.runs, 0),
    types,
    days,
  };
}

/** The change from the window before as a whole percent, or null when there's nothing to compare. */
export function change(total: TypeTotal) {
  if (total.priorMs === null || total.priorMs < 60_000) return null;
  return Math.round(((total.ms - total.priorMs) / total.priorMs) * 100);
}

/** Dev preview: a made-up report for `VITE_AUTH_DISABLED=true` builds, which have no API. */
export function sampleJobTypeTimes(days: number): JobTypeTimes {
  let seed = 11;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const offsetMs = zoneOffset(Date.now()) * 60_000;
  const today = Math.floor((Date.now() + offsetMs) / DAY_MS);
  const start = (today - days + 1) * DAY_MS - offsetMs;
  const compare = days * 2 <= 31;
  // [repo, workflow, job, type, runs a day, minutes a run]
  const specs: [string, string, string, JobType | null, number, number][] = [
    ["acme/app", "CI", "test", "test", 24, 6.5],
    ["acme/api", "CI", "integration", "test", 12, 8],
    ["acme/app", "CI", "unit", "test", 30, 1.5],
    ["acme/app", "CI", "build", "build", 26, 3.2],
    ["acme/api", "Docker", "image", "build", 6, 7],
    ["acme/app", "CI", "lint", "lint", 40, 0.6],
    ["acme/api", "CI", "typecheck", "lint", 18, 0.9],
    ["acme/app", "E2E", "playwright", "e2e", 8, 11],
    ["acme/app", "Release", "publish", "deploy", 3, 4],
    ["acme/api", "Deploy", "deploy", "deploy", 4, 3],
    ["acme/app", "Labeler", "label", "other", 20, 0.3],
    ["acme/api", "Nightly", "benchmarks", null, 1, 14],
  ];
  const jobs = specs.map(([repository, workflow, job, type, perDay, minutes]) => {
    const byDay = Array.from({ length: days }, (_, i) => {
      const weekday = new Date(start + i * DAY_MS).getUTCDay();
      const busy = weekday === 0 || weekday === 6 ? 0.25 : 1;
      return Math.round(perDay * busy * (0.6 + random() * 0.8) * minutes * 60_000);
    });
    const ms = byDay.reduce((sum, each) => sum + each, 0);
    return {
      repository,
      workflow,
      job,
      type,
      runs: Math.round(ms / (minutes * 60_000)),
      ms,
      priorMs: compare ? Math.round(ms * (0.75 + random() * 0.5)) : null,
      byDay,
    };
  });
  jobs.sort((a, b) => b.ms - a.ms);
  return { days, start, ai: true, compare, jobs };
}
