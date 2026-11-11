// Agent feedback (the MCP server's send_feedback tool, apps/api/src/routes/feedback.ts). Shared so
// the tool's schema and the API's checks can't drift apart.
export const FEEDBACK_CATEGORIES = ["bug", "confusing", "feature_request", "other"] as const;
export const FEEDBACK_LIMITS = { summary: 200, details: 4000, tool: 64 } as const;
