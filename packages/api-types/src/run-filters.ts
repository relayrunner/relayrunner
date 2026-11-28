// Who and what a report's runs can be narrowed to: History, Performance and Usage take these as
// query params (apps/api/src/reports/run-filters.ts), and the dashboard keeps them in the URL.

import type { AgentId } from "./agents.ts";

/** Every GitHub login ending in `[bot]`, as one person. */
export const BOTS = "bots";

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

/** What each filter can be set to over a window, busiest first, for the dashboard's filter bar. */
export interface RunFilterOptions {
  workflows: { name: string; runs: number }[];
  people: { login: string; runs: number }[];
  branches: { name: string; runs: number }[];
  triggers: { name: string; runs: number }[];
  agents: { id: AgentId; runs: number }[];
}
