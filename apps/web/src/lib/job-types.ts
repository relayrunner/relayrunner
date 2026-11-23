import { api } from "@/lib/api";
import { addPhases, type PhaseTimes } from "./job-phases.ts";
import { DAY_MS, JOB_TYPE_LABELS, type JobType } from "./job-times.ts";
import { zoneOffset } from "./time-zone.ts";
import { reportQuery, type TimeRange } from "./time-range.ts";
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
  /** Runs that reported their steps, and those steps' time by phase. */
  stepped: number;
  phases: PhaseTimes;
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

export function getJobTypeTimes(range: TimeRange) {
  const query = reportQuery(range, { utcOffset: String(zoneOffset(Date.now())) });
  return api<JobTypeTimes>(`/job-times/types?${query}`);
}

/** A type, or "none" for jobs not sorted yet. */
export type TypeKey = JobType | "none";

// Every type's label, in the order types stack and list in, which their colors were checked for.
const TYPE_LABELS = {
  test: JOB_TYPE_LABELS.test,
  build: JOB_TYPE_LABELS.build,
  lint: JOB_TYPE_LABELS.lint,
  e2e: JOB_TYPE_LABELS.e2e,
  deploy: JOB_TYPE_LABELS.deploy,
  other: JOB_TYPE_LABELS.other,
  none: "Not sorted",
} satisfies Record<TypeKey, string>;

export const TYPE_ORDER = Object.keys(TYPE_LABELS) as TypeKey[];

export const typeLabel = (key: TypeKey) => TYPE_LABELS[key];

export const typeColor = (key: TypeKey) => `var(--job-${key})`;

export type TypeTotal = {
  key: TypeKey;
  ms: number;
  runs: number;
  /** Null when the window before isn't known. */
  priorMs: number | null;
  /** Its jobs with runs, the most time first. */
  jobs: JobTypeTime[];
  stepped: number;
  phases: PhaseTimes;
};

export type TypeSummary = {
  ms: number;
  runs: number;
  stepped: number;
  phases: PhaseTimes;
  /** Types with time in the window, in TYPE_ORDER. */
  types: TypeTotal[];
  /** Each day's local midnight, its run time by type and in all. */
  days: { start: number; ms: Partial<Record<TypeKey, number>>; total: number }[];
};

/** Adds the report's jobs up by type, for one repo or all of them. */
export function summarize(report: JobTypeTimes, repository = "all"): TypeSummary {
  const totals = new Map<TypeKey, TypeTotal>();
  const days = Array.from({ length: report.days }, (_, i) => ({
    start: report.start + i * DAY_MS,
    ms: {} as Partial<Record<TypeKey, number>>,
    total: 0,
  }));
  for (const job of report.jobs) {
    if (repository !== "all" && job.repository !== repository) continue;
    const key = job.type ?? "none";
    let total = totals.get(key);
    if (!total) {
      total = {
        key,
        ms: 0,
        runs: 0,
        priorMs: report.compare ? 0 : null,
        jobs: [],
        stepped: 0,
        phases: {},
      };
      totals.set(key, total);
    }
    total.ms += job.ms;
    total.runs += job.runs;
    total.stepped += job.stepped;
    addPhases(total.phases, job.phases);
    if (total.priorMs !== null) total.priorMs += job.priorMs ?? 0;
    if (job.runs > 0) total.jobs.push(job);
    job.byDay.forEach((ms, i) => {
      const day = days[i];
      if (!ms || !day) return;
      day.ms[key] = (day.ms[key] ?? 0) + ms;
      day.total += ms;
    });
  }
  const types = TYPE_ORDER.flatMap((key) => {
    const total = totals.get(key);
    return total && total.ms > 0 ? [total] : [];
  });
  return {
    ms: types.reduce((sum, type) => sum + type.ms, 0),
    runs: types.reduce((sum, type) => sum + type.runs, 0),
    stepped: types.reduce((sum, type) => sum + type.stepped, 0),
    phases: types.reduce((sum, type) => addPhases(sum, type.phases), {} as PhaseTimes),
    types,
    days,
  };
}

/** The change from the window before as a whole percent, or null when there's nothing to compare. */
export function change(total: TypeTotal) {
  if (total.priorMs === null || total.priorMs < 60_000) return null;
  return Math.round(((total.ms - total.priorMs) / total.priorMs) * 100);
}
