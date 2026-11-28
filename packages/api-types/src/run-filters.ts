// Who and what a report's runs can be narrowed to: History, Performance and Usage take these as
// query params (apps/api/src/reports/run-filters.ts), and the dashboard keeps them in the URL. The
// parsing and matching live here so the API, the dashboard and its sample data agree.

import { type AgentId, agentById, type RunAgent } from "./agents.ts";

/** Every GitHub login ending in `[bot]`, as one person. */
export const BOTS = "bots";

export const isBotLogin = (login: string | null | undefined) => !!login?.endsWith("[bot]");

/** How far back jobs keep their own rows, the only ones that know who or what started a job. */
export const RAW_RETENTION_DAYS = 62;

/** Runs from any agent, or from none. */
export type AgentFilter = AgentId | "any" | "none";

export interface RunFilters {
  /** A workflow's name, in any repo. */
  workflow?: string;
  /** The GitHub login that started the run, or BOTS. */
  person?: string;
  branch?: string;
  /** What triggered the run: push, pull_request, schedule, workflow_dispatch, ... */
  trigger?: string;
  agent?: AgentFilter;
}

export const RUN_FILTER_KEYS = [
  "workflow",
  "person",
  "branch",
  "trigger",
  "agent",
] as const satisfies readonly (keyof RunFilters)[];

export type RunFilterKey = (typeof RUN_FILTER_KEYS)[number];

/** Longest value a filter takes, so a query param can't grow a statement without bound. */
const MAX_LENGTH = 200;

const isAgentFilter = (value: string): value is AgentFilter =>
  value === "any" || value === "none" || agentById(value) !== undefined;

/**
 * The filters in a query or a page's URL, only `keys` of them; anything empty, too long or unknown
 * is left out, so equal sets compare equal.
 */
export function parseRunFilters(
  query: object,
  keys: readonly RunFilterKey[] = RUN_FILTER_KEYS,
): RunFilters {
  const filters: RunFilters = {};
  for (const key of keys) {
    const raw = (query as Record<string, unknown>)[key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || value.length > MAX_LENGTH) continue;
    if (key !== "agent") filters[key] = value;
    else if (isAgentFilter(value)) filters.agent = value;
  }
  return filters;
}

export const hasRunFilters = (filters: RunFilters) =>
  RUN_FILTER_KEYS.some((key) => filters[key] !== undefined);

/** A run as the filters see it. */
export interface FilterableRun {
  workflow: string | null;
  /** Who started it. */
  person: string | null;
  branch: string | null;
  event: string | null;
  agent: RunAgent | null;
}

/** Whether a run matches every filter that's set. */
export function runMatches(filters: RunFilters, run: FilterableRun): boolean {
  const { workflow, person, branch, trigger, agent } = filters;
  if (workflow && run.workflow !== workflow) return false;
  if (person === BOTS && !isBotLogin(run.person)) return false;
  if (person && person !== BOTS && run.person !== person) return false;
  if (branch && run.branch !== branch) return false;
  if (trigger && run.event !== trigger) return false;
  if (agent === "any" && !run.agent) return false;
  if (agent === "none" && run.agent) return false;
  if (agent && agent !== "any" && agent !== "none" && run.agent?.id !== agent) return false;
  return true;
}

/** One value a filter can take over a window, with how many runs had it. */
export type RunFilterChoice = { value: string; runs: number };

/** What each filter can be set to over a window, busiest first, for the dashboard's filter bar. */
export type RunFilterOptions = Record<RunFilterKey, RunFilterChoice[]>;

/** Counts runs by each filter's value, busiest first, then by name. */
export function tallyRunFilters(runs: Iterable<FilterableRun & { runs?: number }>) {
  const counts = Object.fromEntries(
    RUN_FILTER_KEYS.map((key) => [key, new Map<string, number>()]),
  ) as Record<RunFilterKey, Map<string, number>>;
  const add = (key: RunFilterKey, value: string | null | undefined, n: number) => {
    if (value) counts[key].set(value, (counts[key].get(value) ?? 0) + n);
  };
  for (const run of runs) {
    const n = run.runs ?? 1;
    add("workflow", run.workflow, n);
    add("person", run.person, n);
    add("branch", run.branch, n);
    add("trigger", run.event, n);
    add("agent", run.agent?.id, n);
  }
  return Object.fromEntries(
    RUN_FILTER_KEYS.map((key) => [
      key,
      [...counts[key]]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, n]) => ({ value, runs: n })),
    ]),
  ) as RunFilterOptions;
}
