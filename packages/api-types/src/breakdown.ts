// The ways GET /api/usage/breakdown (apps/api/src/reports/breakdown.ts) cuts a workspace's jobs,
// and what it sorts the rows by, shared with the MCP server's get_breakdown tool.

export const BREAKDOWN_BY = [
  "repository",
  "workflow",
  "job",
  "person",
  "branch",
  "trigger",
  "agent",
  "provider",
  "runner",
  "job_type",
] as const;
export type BreakdownBy = (typeof BREAKDOWN_BY)[number];

export const BREAKDOWN_SORTS = ["minutes", "runs", "jobs", "cost", "failures"] as const;
export type BreakdownSort = (typeof BREAKDOWN_SORTS)[number];

/** Most rows a breakdown lists; the rest are added up. */
export const BREAKDOWN_MAX_ROWS = 100;
