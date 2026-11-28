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

/** Rows a breakdown lists unless asked for more, and the most it lists; the rest are added up. */
export const BREAKDOWN_DEFAULT_ROWS = 20;
export const BREAKDOWN_MAX_ROWS = 100;

/** The furthest a reader's time zone is from UTC, in minutes, for a report's `utcOffset`. */
export const MAX_UTC_OFFSET_MINUTES = 840;
