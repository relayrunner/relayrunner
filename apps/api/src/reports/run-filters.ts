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
  RUN_FILTER_KEYS,
  type RunFilterOptions,
  type RunFilters,
  runAgent,
} from "@relayrunner/api-types";
import { type SQL, sql } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import { inWorkspace } from "./job-sql.ts";
import type { Window } from "./report-window.ts";

const runs = schema.workflowRun;
const timing = schema.jobTiming;

/** Longest value a filter takes, so a query param can't grow a statement without bound. */
const MAX_LENGTH = 200;

/** The filters in a request's query; anything empty, too long or unknown is left out. */
export function parseRunFilters(query: Record<string, string | undefined>): RunFilters {
  const filters: RunFilters = {};
  for (const key of RUN_FILTER_KEYS) {
    const value = query[key]?.trim();
    if (!value || value.length > MAX_LENGTH) continue;
    if (key === "agent") {
      if (value === "any" || value === "none" || agentById(value))
        filters.agent = value as AgentFilter;
    } else filters[key] = value;
  }
  return filters;
}

export const hasRunFilters = (filters: RunFilters) =>
  RUN_FILTER_KEYS.some((key) => filters[key] !== undefined);

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
  if (filters.person === BOTS) conditions.push(sql`${PERSON} like '%[bot]'`);
  else if (filters.person) conditions.push(sql`${PERSON} = ${filters.person}`);
  if (filters.branch) conditions.push(sql`${runs.headBranch} = ${filters.branch}`);
  if (filters.trigger) conditions.push(sql`${runs.event} = ${filters.trigger}`);
  if (filters.agent) conditions.push(agentSql(filters.agent));
  return conditions;
}

/**
 * The filters as SQL over job_timing, starting with ` and `, or nothing without any. Jobs match
 * through their run's row; `table` names another alias of job_timing.
 */
export function jobFilterSql(filters: RunFilters, table = timing): SQL {
  const parts: SQL[] = [];
  if (filters.workflow) parts.push(sql`${table.workflowName} = ${filters.workflow}`);
  const conditions = runConditions(filters);
  if (conditions.length)
    parts.push(sql`exists (select 1 from ${runs}
      where ${runs.id} = ${table.runId} and ${runs.runAttempt} = ${table.runAttempt}
        and ${sql.join(conditions, sql` and `)})`);
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``;
}

type RunRow = Pick<
  typeof runs.$inferSelect,
  "workflowName" | "startedByLogin" | "actorLogin" | "headBranch" | "event" | "agent"
>;

/** Whether a run matches, from its workflow_run row (undefined when it was never stored). */
export function runMatches(
  filters: RunFilters,
  row: RunRow | undefined,
  workflow: string | null,
): boolean {
  if (filters.workflow && workflow !== filters.workflow) return false;
  const { workflow: _, ...rest } = filters;
  if (!hasRunFilters(rest)) return true;
  if (!row) return false;
  const person = row.startedByLogin ?? row.actorLogin;
  if (
    filters.person === BOTS
      ? !person?.endsWith("[bot]")
      : filters.person && person !== filters.person
  )
    return false;
  if (filters.branch && row.headBranch !== filters.branch) return false;
  if (filters.trigger && row.event !== filters.trigger) return false;
  if (filters.agent) {
    const agent = runAgent(row.agent, row.headBranch);
    if (
      filters.agent === "any"
        ? !agent
        : filters.agent === "none"
          ? agent
          : agent?.id !== filters.agent
    )
      return false;
  }
  return true;
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
      person: PERSON,
      branch: runs.headBranch,
      trigger: runs.event,
      agent: runs.agent,
      runs: sql<number>`count(*)`,
    })
    .from(runs)
    .where(
      sql`${inWorkspace(workspaceId, runs.installationId)}
        and ${runs.githubUpdatedAt} >= ${from} and ${runs.githubUpdatedAt} < ${to}`,
    )
    .groupBy(runs.workflowName, PERSON, runs.headBranch, runs.event, runs.agent);

  const counts = {
    workflows: new Map<string, number>(),
    people: new Map<string, number>(),
    branches: new Map<string, number>(),
    triggers: new Map<string, number>(),
    agents: new Map<string, number>(),
  };
  const add = (map: Map<string, number>, key: string | null | undefined, n: number) => {
    if (key) map.set(key, (map.get(key) ?? 0) + n);
  };
  for (const row of rows) {
    const n = Number(row.runs);
    add(counts.workflows, row.workflow, n);
    add(counts.people, row.person as string | null, n);
    add(counts.branches, row.branch, n);
    add(counts.triggers, row.trigger, n);
    add(counts.agents, runAgent(row.agent, row.branch)?.id, n);
  }
  const busiest = (map: Map<string, number>) =>
    [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    workflows: busiest(counts.workflows).map(([name, n]) => ({ name, runs: n })),
    people: busiest(counts.people).map(([login, n]) => ({ login, runs: n })),
    branches: busiest(counts.branches)
      .slice(0, BRANCH_LIMIT)
      .map(([name, n]) => ({ name, runs: n })),
    triggers: busiest(counts.triggers).map(([name, n]) => ({ name, runs: n })),
    agents: busiest(counts.agents).map(([id, n]) => ({
      id: id as RunFilterOptions["agents"][number]["id"],
      runs: n,
    })),
  };
}
