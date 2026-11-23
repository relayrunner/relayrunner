// Where CI time goes, by what each job does: run minutes for every job in a window, cut at the
// reader's midnight, with the job's type from the AI classifier (src/ai/job-type.ts).
// The dashboard adds them up by type, so its repo filter needs no second read.
import { matrixName, windowWhere } from "./job-sql.ts";
import { DAY_MS } from "../time.ts";
import { sql } from "drizzle-orm";
import type { JobType } from "@relayrunner/api-types";
import { jobTypeKey, readJobTypes } from "../ai/job-type.ts";
import { aiAccess } from "../ai/settings.ts";
import { type Db, schema } from "../db/index.ts";
import { hasTrend, type ReportWindow } from "./report-window.ts";
import { addStep, type PhaseTimes } from "./step-phases.ts";

const table = schema.jobTiming;

export type JobTypeTime = {
  repository: string;
  workflow: string | null;
  /** The job's name; a matrix job's legs are added up under their shared name. */
  job: string;
  /** Null until the model has read the job, or when it wasn't sure. */
  type: JobType | null;
  runs: number;
  /** Run time, from a runner taking the job to it finishing. */
  ms: number;
  /** Run time in the prior window, when raw timings still go back that far. */
  priorMs: number | null;
  /** Run time on each day of the window, oldest first. */
  byDay: number[];
  /** Runs in the window that reported their steps, and those steps' time by phase. */
  stepped: number;
  phases: PhaseTimes;
};

export type JobTypeTimes = {
  days: number;
  /** The first day's local midnight, in epoch ms. */
  start: number;
  /** Whether the classifier may read this workspace's jobs. */
  ai: boolean;
  /** Whether each job has priorMs. */
  compare: boolean;
  /** The most run time first. */
  jobs: JobTypeTime[];
};

type Row = {
  repository_id: number;
  repository: string;
  workflow_name: string | null;
  name: string;
  /** The local day, or -1 for the prior window. */
  day: number;
  runs: number;
  run_ms: number;
  stepped: number;
};

type StepRow = {
  repository_id: number;
  workflow_name: string | null;
  name: string;
  step: string;
  seconds: number;
};

/**
 * The workspace's run time per job and local day (`utcOffset` minutes east of UTC) in the window,
 * from its first whole local day, plus the prior window when timings still cover it.
 */
export async function jobTypeTimes(
  db: Db,
  workspaceId: string,
  window: ReportWindow,
  { utcOffset = 0, now = Date.now() }: { utcOffset?: number; now?: number } = {},
): Promise<JobTypeTimes> {
  const offsetMs = utcOffset * 60_000;
  const localDay = (ms: number) => Math.floor((ms + offsetMs) / DAY_MS);
  // The first local midnight at or after the window's start, so the last 7 days are 7 day columns.
  const first = Math.ceil((window.from + offsetMs) / DAY_MS);
  const start = first * DAY_MS - offsetMs;
  const days = Math.max(1, localDay(window.to - 1) - first + 1);
  const compare = hasTrend(window, now);
  const since = new Date(compare ? Math.min(window.prior.from, start) : start);
  // Not the days between the prior window and the window, such as the end of last month.
  const gap = compare
    ? sql` and (${table.completedAt} < ${window.prior.to} or ${table.completedAt} >= ${start})`
    : sql``;
  // The local day, or one bucket for all of the prior window (its days aren't shown). Cast, since
  // D1 may bind the numbers as reals.
  const day = sql`case when ${table.completedAt} < ${start} then -1
    else cast((${table.completedAt} + ${offsetMs}) / ${DAY_MS} as integer) end`;

  const [rows, steps, types, access] = await Promise.all([
    db.all<Row>(sql`
      select ${table.repositoryId} as repository_id, min(${table.repositoryFullName}) as repository,
        ${table.workflowName} as workflow_name, ${table.name} as name, ${day} as day,
        count(*) as runs, sum(${table.completedAt} - ${table.startedAt}) as run_ms,
        count(${table.steps}) as stepped
      from ${table} where ${windowWhere(workspaceId, since, window.to)}${gap}
      group by ${table.repositoryId}, ${table.workflowName}, ${table.name}, ${day}`),
    // Each job's seconds per step name in the window, sorted into phases below.
    db.all<StepRow>(sql`
      select ${table.repositoryId} as repository_id, ${table.workflowName} as workflow_name,
        ${table.name} as name, step.value ->> 0 as step, sum(step.value ->> 1) as seconds
      from ${table}, json_each(${table.steps}) as step
      where ${windowWhere(workspaceId, new Date(start), window.to)}
      group by ${table.repositoryId}, ${table.workflowName}, ${table.name}, step.value ->> 0`),
    readJobTypes(db, workspaceId),
    aiAccess(db, workspaceId, "job_type", now),
  ]);

  const jobs = new Map<string, JobTypeTime>();
  for (const row of rows) {
    const key = jobTypeKey(row.repository_id, row.workflow_name, row.name);
    let job = jobs.get(key);
    if (!job) {
      job = {
        repository: row.repository,
        workflow: row.workflow_name,
        job: matrixName(row.name) ?? row.name,
        type: types.get(key) ?? null,
        runs: 0,
        ms: 0,
        priorMs: compare ? 0 : null,
        byDay: Array.from({ length: days }, () => 0),
        stepped: 0,
        phases: {},
      };
      jobs.set(key, job);
    }
    const ms = Math.max(0, Number(row.run_ms));
    if (Number(row.day) === -1) {
      job.priorMs = (job.priorMs ?? 0) + ms;
      continue;
    }
    const index = Number(row.day) - first;
    if (index < 0 || index >= days) continue;
    job.runs += Number(row.runs);
    job.stepped += Number(row.stepped);
    job.ms += ms;
    job.byDay[index]! += ms;
  }

  for (const row of steps) {
    const job = jobs.get(jobTypeKey(row.repository_id, row.workflow_name, row.name));
    if (job) addStep(job.phases, row.step, Number(row.seconds));
  }

  return {
    days,
    start,
    ai: access !== null,
    compare,
    // A job seen only in the window before keeps a row with no runs, for its type's change.
    jobs: [...jobs.values()].sort((a, b) => b.ms - a.ms || (b.priorMs ?? 0) - (a.priorMs ?? 0)),
  };
}
