// Feedback from agents (the MCP server's send_feedback tool) and people (the dashboard's feedback
// popover), both through apps/api/src/routes/feedback.ts. Shared so the tool's schema, the
// dashboard's form and the API's checks can't drift apart. A person's message is one text, held to
// `details`.
export const FEEDBACK_CATEGORIES = ["bug", "confusing", "feature_request", "other"] as const;
export const FEEDBACK_LIMITS = { summary: 200, details: 4000, tool: 64, page: 200 } as const;
