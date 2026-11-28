// Narrowing a report's runs by who and what started them (RunFilters in @relayrunner/api-types):
// History's runs and jobs, Performance and Usage take `?workflow=&person=&branch=&trigger=&agent=`.
// Jobs match through their run's workflow_run row, so a job whose run was never stored matches
// only a workflow filter.
//
// Database cost: a filtered job report looks up each job's run by workflow_run's primary key, one
// row per job it reads. The options are one range of workflow_run_installation_idx.
import {
  AGENTS,
  type AgentFilter,
  agentById,
  BOTS,
  type FilterableRun,
  hasRunFilters,
  type RunFilterOptions,
  type RunFilters,
  runAgent,
  runMatches,
  tallyRunFilters,
} from "@relayrunner/api-types";
import { type SQL, sql } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import { inWorkspace } from "./job-sql.ts";
import type { Window } from "./report-window.ts";

const runs = schema.workflowRun;
const timing = schema.jobTiming;

/** Who started a run: its first attempt's starter, else whoever started this attempt. */
const PERSON = sql`coalesce(${runs.startedByLogin}, ${runs.actorLogin})`;

/** A branch name that starts with one of an agent's prefixes, in SQL. */
function branchLike(prefixes: readonly string[]): SQL {
  if (!prefixes.length) return sql`0`;
  return sql.join(
    prefixes.map((prefix) => sql`lower(${runs.headBranch}) like ${`${prefix}%`}`),
    sql` or `,
  );
}

const ANY_BRANCH_PREFIX = AGENTS.flatMap((agent) => agent.branchPrefixes);

/** A run from the agent the filter names, by its stored agent or else its branch name. */
function agentSql(agent: AgentFilter): SQL {
  const any = sql`(${runs.agent} is not null or (${branchLike(ANY_BRANCH_PREFIX)}))`;
  if (agent === "any") return any;
  if (agent === "none") return sql`not ${any}`;
  const prefixes = agentById(agent)?.branchPrefixes ?? [];
  return sql`(${runs.agent} = ${agent} or (${runs.agent} is null and (${branchLike(prefixes)})))`;
}

/** The conditions on a workflow_run row, but the workflow (which job_timing has too). */
function runConditions(filters: RunFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.person === BOTS) conditions.push(sql`${PERSON} like '%[bot]'`); // isBotLogin, in SQL
  else if (filters.person) conditions.push(sql`${PERSON} = ${filters.person}`);
  if (filters.branch) conditions.push(sql`${runs.headBranch} = ${filters.branch}`);
  if (filters.trigger) conditions.push(sql`${runs.event} = ${filters.trigger}`);
  if (filters.agent) conditions.push(agentSql(filters.agent));
  return conditions;
}

/**
 * The filters as one condition over job_timing (`1` without any), for after an ` and `. Jobs match
 * through their run's row.
 */
export function jobFilterSql(filters: RunFilters): SQL {
  const parts: SQL[] = [];
  if (filters.workflow) parts.push(sql`${timing.workflowName} = ${filters.workflow}`);
  const conditions = runConditions(filters);
  if (conditions.length)
    parts.push(sql`exists (select 1 from ${runs}
      where ${runs.id} = ${timing.runId} and ${runs.runAttempt} = ${timing.runAttempt}
        and ${sql.join(conditions, sql` and `)})`);
  return parts.length ? sql.join(parts, sql` and `) : sql`1`;
}

type RunRow = Pick<
  typeof runs.$inferSelect,
  "startedByLogin" | "actorLogin" | "headBranch" | "event" | "agent"
>;

/** A workflow_run row as the filters see it. */
const filterable = (row: RunRow, workflow: string | null): FilterableRun => ({
  workflow,
  person: row.startedByLogin ?? row.actorLogin,
  branch: row.headBranch,
  event: row.event,
  agent: runAgent(row.agent, row.headBranch),
});

/**
 * Whether a run matches, from its workflow_run row. A run that was never stored has only its
 * workflow to match, as jobFilterSql treats its jobs.
 */
export function rowMatches(filters: RunFilters, row: RunRow | undefined, workflow: string | null) {
  if (row) return runMatches(filters, filterable(row, workflow));
  const { workflow: only, ...rest } = filters;
  return !hasRunFilters(rest) && (!only || only === workflow);
}

/** Most branches the options list, busiest first: the rest are typed in through the URL. */
const BRANCH_LIMIT = 30;

/** What each filter can be set to over the window, from the runs that changed in it. */
export async function runFilterOptions(
  db: Db,
  workspaceId: string,
  { from, to }: Window,
): Promise<RunFilterOptions> {
  const rows = await db
    .select({
      workflow: runs.workflowName,
      person: sql<string | null>`${PERSON}`,
      headBranch: runs.headBranch,
      event: runs.event,
      agent: runs.agent,
      runs: sql<number>`count(*)`,
    })
    .from(runs)
    .where(
      sql`${inWorkspace(workspaceId, runs.installationId)}
        and ${runs.githubUpdatedAt} >= ${from} and ${runs.githubUpdatedAt} < ${to}`,
    )
    .groupBy(runs.workflowName, PERSON, runs.headBranch, runs.event, runs.agent);

  const options = tallyRunFilters(
    rows.map((row) => ({
      ...filterable({ ...row, startedByLogin: row.person, actorLogin: null }, row.workflow),
      runs: Number(row.runs),
    })),
  );
  return { ...options, branch: options.branch.slice(0, BRANCH_LIMIT) };
}
