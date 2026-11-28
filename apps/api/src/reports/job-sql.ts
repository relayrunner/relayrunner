// SQL fragments over job_timing that the reports share: which jobs ran, passed or were picks, their
// run and wait times, and the workspace and window they belong to.
import { type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema } from "../db/index.ts";
import { RELAYRUNNER_LABEL } from "../routing/labels.ts";

const table = schema.jobTiming;

/** A finished job's run time, start to finish, in SQL. */
export const DURATION_MS = sql`max(0, ${table.completedAt} - ${table.startedAt})`;
/** The minutes GitHub bills a job: its run time rounded up, at least one. */
export const BILLED_MINUTES = sql`max(1, (${DURATION_MS} + 59999) / 60000)`;
/** How long a job waited for a runner, queued to started. Null when either is unknown. */
export const WAIT_MS = sql`(${table.startedAt} - ${table.queuedAt})`;
/** A failed job whose runner gave up before any of its steps ran. */
export const RUNNER_FAILED = sql`(${table.conclusion} = 'failure' and ${table.ranSteps} = 0)`;

/** A pick (`runs-on: relayrunner`): it only routes its run. */
export const PICK = sql`lower(${table.labels}) like ${`%"${RELAYRUNNER_LABEL}"%`}`;

/** A job a runner ran: started and not skipped. Cancelled jobs that started count. */
export const RAN_ON_RUNNER = sql`${table.startedAt} is not null and ${table.runnerName} is not null
  and coalesce(${table.conclusion}, '') <> 'skipped'`;

// A job a runner ran, picks left out: they would split every routed run across two environments,
// like on the Usage page; only successes give times.
export const RAN = sql`${RAN_ON_RUNNER} and not ${PICK}`;

export const OK = sql`coalesce(${table.conclusion} = 'success', 0)`;
/** A job that failed or timed out. Cancelled jobs are neither this nor OK. */
export const FAILED = sql`coalesce(${table.conclusion} in ('failure', 'timed_out'), 0)`;

// How long a job waits with no runner before it counts as missed. Shorter waits are left out, since
// a concurrency group or a person cancels those.
export const MISSED_AFTER_MS = 10 * 60_000;

/** A job no runner took: it finished (GitHub gave up, or it was cancelled) after a long wait. */
export const NOT_PICKED_UP = sql`(${table.startedAt} is null or ${table.runnerName} is null)
  and coalesce(${table.conclusion}, '') <> 'skipped' and not ${PICK}
  and ${table.completedAt} - ${table.queuedAt} >= ${MISSED_AFTER_MS}`;

// `completedAt:runMs:waitMs` per successful run, comma separated, as parseSamples reads it.
export const SAMPLES = sql`group_concat(case when ${OK} then ${table.completedAt} || ':'
  || (${table.completedAt} - ${table.startedAt}) || ':'
  || coalesce(${table.startedAt} - ${table.queuedAt}, '') end)`;

/**
 * The row's installation (job_timing's unless another column is given) is the workspace's. An
 * equality, not `in`: with `in`, SQLite walks the all-workspaces completed_at index for a newest-first
 * list and reads every workspace's jobs in the window.
 */
export function inWorkspace(
  workspaceId: string,
  installationId: SQLiteColumn = table.installationId,
): SQL {
  return sql`${installationId} = (
    select ${schema.workspace.installationId} from ${schema.workspace}
    where ${schema.workspace.id} = ${workspaceId})`;
}

/** Before `until` (epoch ms), when the window ends before now. */
export const before = (until?: number) =>
  until === undefined ? sql`` : sql` and ${table.completedAt} < ${until}`;

/** The jobs a report counts: the workspace's, finished since `since`, run by a runner, not picks. */
export const windowWhere = (workspaceId: string, since: Date, until?: number) =>
  sql`${inWorkspace(workspaceId)} and ${table.completedAt} >= ${since.getTime()}${before(until)}
    and ${RAN}`;

// `test (node 24)` is a leg of matrix job `test`.
export function matrixName(name: string) {
  const at = name.indexOf(" (");
  return at > 0 && name.endsWith(")") ? name.slice(0, at) : null;
}
