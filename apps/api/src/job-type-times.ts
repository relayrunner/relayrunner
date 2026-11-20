// Where CI time goes, by what each job does: run minutes for every job over the last `days` days,
// cut at the reader's midnight, with the job's type from the AI classifier (src/ai/job-type.ts).
// The dashboard adds them up by type, so its repo filter needs no second read.
import { sql } from "drizzle-orm";
import { type JobTypeKind, jobTypeKey, readJobTypes } from "./ai/job-type.ts";
import { aiAccess } from "./ai/settings.ts";
import { type Db, schema } from "./db/index.ts";
import { DAY_MS } from "./job-timings.ts";
import { hasTrend, matrixName, windowWhere } from "./job-times.ts";

const table = schema.jobTiming;

export type JobTypeTime = {
  repository: string;
  workflow: string | null;
  /** The job's name; a matrix job's legs are added up under their shared name. */
  job: string;
  /** Null until the model has read the job, or when it wasn't sure. */
  type: JobTypeKind | null;
  runs: number;
  /** Run time, from a runner taking the job to it finishing. */
  ms: number;
  /** Run time in the window just as long before, when raw timings still go back that far. */
  priorMs: number | null;
  /** Run time on each day of the window, oldest first. */
  byDay: number[];
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
  day: number;
  runs: number;
  run_ms: number;
};

/**
 * The workspace's run time per job and local day (`utcOffset` minutes east of UTC) for the last
 * `days` days, today included, plus the window before when timings still cover it.
 */
export async function jobTypeTimes(
  db: Db,
  workspaceId: string,
  days: number,
  { utcOffset = 0, now = Date.now() }: { utcOffset?: number; now?: number } = {},
): Promise<JobTypeTimes> {
  const offsetMs = utcOffset * 60_000;
  const today = Math.floor((now + offsetMs) / DAY_MS);
  const first = today - days + 1;
  const start = first * DAY_MS - offsetMs;
  const compare = hasTrend(days);
  const since = new Date(compare ? start - days * DAY_MS : start);
  // The local day, or one bucket for all of the window before (its days aren't shown). Cast, since
  // D1 may bind the numbers as reals.
  const day = sql`case when ${table.completedAt} < ${start} then -1
    else cast((${table.completedAt} + ${offsetMs}) / ${DAY_MS} as integer) end`;

  const [rows, types, access] = await Promise.all([
    db.all<Row>(sql`
      select ${table.repositoryId} as repository_id, min(${table.repositoryFullName}) as repository,
        ${table.workflowName} as workflow_name, ${table.name} as name, ${day} as day,
        count(*) as runs, sum(${table.completedAt} - ${table.startedAt}) as run_ms
      from ${table} where ${windowWhere(workspaceId, since)}
      group by ${table.repositoryId}, ${table.workflowName}, ${table.name}, ${day}`),
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
    job.ms += ms;
    job.byDay[index]! += ms;
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
