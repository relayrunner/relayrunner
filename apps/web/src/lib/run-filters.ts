// Who and what a report's runs are narrowed to (RunFilters in @relayrunner/api-types): History,
// Performance and Usage keep them in the URL, each left out while unset, and send them to the API.
// No imports from the app, so the report modules that send them stay testable on their own.
import {
  agentById,
  BOTS,
  RUN_FILTER_KEYS,
  type AgentFilter,
  type RunFilterOptions,
  type RunFilters,
} from "@relayrunner/api-types";

export type RunFilterKey = (typeof RUN_FILTER_KEYS)[number];
export type { RunFilterOptions, RunFilters };
export { BOTS, RUN_FILTER_KEYS };

const textParam = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The filters in a page's URL. */
export function runFilterSearch(search: Record<string, unknown>): RunFilters {
  const agent = textParam(search.agent);
  return {
    workflow: textParam(search.workflow),
    person: textParam(search.person),
    branch: textParam(search.branch),
    trigger: textParam(search.trigger),
    agent:
      agent === "any" || agent === "none" || (agent && agentById(agent))
        ? (agent as AgentFilter)
        : undefined,
  };
}

/** Only the filters that are set, so equal sets make equal query keys. */
export function setFilters(filters: RunFilters, keys: readonly RunFilterKey[] = RUN_FILTER_KEYS) {
  const set: RunFilters = {};
  for (const key of keys) if (filters[key]) Object.assign(set, { [key]: filters[key] });
  return set;
}

/** The filters as query params for the API. */
export const filterQuery = (filters: RunFilters) => setFilters(filters) as Record<string, string>;

export const hasFilters = (filters: RunFilters) => Object.keys(setFilters(filters)).length > 0;

const TRIGGERS: Record<string, string> = {
  push: "Push",
  pull_request: "Pull request",
  pull_request_target: "Pull request target",
  schedule: "Schedule",
  workflow_dispatch: "Manual",
  merge_group: "Merge queue",
  release: "Release",
  workflow_run: "After another workflow",
  repository_dispatch: "Repository dispatch",
};

/** A trigger's name as people say it: `pull_request` is "Pull request". */
export function triggerLabel(event: string) {
  const known = TRIGGERS[event];
  if (known) return known;
  const words = event.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a filter's value reads as. */
export function filterValueLabel(key: RunFilterKey, value: string) {
  if (key === "trigger") return triggerLabel(value);
  if (key === "person" && value === BOTS) return "Bots";
  if (key === "agent") {
    if (value === "any") return "Any agent";
    if (value === "none") return "No agent";
    return agentById(value)?.name ?? value;
  }
  return value;
}

export const FILTER_NAMES: Record<RunFilterKey, string> = {
  workflow: "Workflow",
  person: "Person",
  branch: "Branch",
  trigger: "Trigger",
  agent: "Agent",
};
