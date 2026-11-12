import { and, eq, gt, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AGENT_WORKSPACE_HEADER, agentWorkspaceId } from "../agent-auth.ts";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { emailOperators } from "../email.ts";
import { FEEDBACK_CATEGORIES, FEEDBACK_LIMITS } from "@relayrunner/activity";
import { FEEDBACK_RATE, sanitizeFeedback, sanitizeMessage } from "../feedback.ts";
import { inBackground, requireUser } from "../middleware/session.ts";
import { membership } from "../middleware/workspace.ts";

// Raw input may run a little over the stored limits (whitespace, invisible characters) before
// cleaning trims it; anything far over is refused rather than silently cut.
const slack = (max: number) => Math.ceil(max * 1.25);
const AgentBody = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  summary: z.string().min(1).max(slack(FEEDBACK_LIMITS.summary)),
  details: z.string().max(slack(FEEDBACK_LIMITS.details)).optional(),
  tool: z.string().max(FEEDBACK_LIMITS.tool).optional(),
});
const DashboardBody = z.object({
  message: z.string().min(1).max(slack(FEEDBACK_LIMITS.details)),
  page: z.string().max(slack(FEEDBACK_LIMITS.page)).optional(),
});

const HOUR_MS = 60 * 60 * 1000;

/** Feedback ready to store, from either source, and how many secret-like values were redacted. */
type Entry = {
  source: "agent" | "dashboard";
  category: string;
  summary: string;
  details: string | null;
  tool?: string | null;
  page?: string | null;
  grantId?: string;
  clientId?: string;
  redacted: number;
};

// Feedback from a person in the dashboard (the feedback popover) or from an agent (the MCP server's
// send_feedback tool). Either way it's stored for the signed-in user, with the workspace it's
// about, and emailed to FEEDBACK_EMAIL (and operators who opted in) with a reply-to of the person. An agent's records which
// agent sent it, and its workspace is the one the request names; a person's records the page and
// their active workspace. The answer never repeats what was sent, so a secret the redaction missed
// isn't echoed back.
export const feedbackRoutes = new Hono<AppEnv>().post(
  "/",
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }),
  requireUser,
  async (c) => {
    const { agent, user } = c.var;
    const db = createDb(c.env.DB);
    const body = await c.req.json().catch(() => null);

    let workspace: () => Promise<{ id: string; name: string } | null>;
    let entry: Entry;
    if (agent) {
      const requested = c.req.header(AGENT_WORKSPACE_HEADER);
      const workspaceId = agentWorkspaceId(agent, requested);
      if (requested && !workspaceId) return c.json({ error: "not_found" }, 404);
      const parsed = AgentBody.safeParse(body);
      if (!parsed.success) return invalid(c, parsed.error);
      entry = {
        ...sanitizeFeedback(parsed.data),
        source: "agent",
        grantId: agent.grantId,
        clientId: agent.clientId,
      };
      workspace = async () => agent.workspaces.find((w) => w.id === workspaceId) ?? null;
    } else {
      const parsed = DashboardBody.safeParse(body);
      if (!parsed.success) return invalid(c, parsed.error);
      entry = {
        ...sanitizeMessage(parsed.data.message, parsed.data.page),
        source: "dashboard",
        // Kept for the agents' categories; the source tells a person's message apart.
        category: "other",
      };
      const activeId = c.var.session?.activeOrganizationId;
      workspace = async () =>
        activeId ? ((await membership(db, activeId, user!.id))?.workspace ?? null) : null;
    }
    if (!entry.summary) return c.json({ error: "invalid_body", fields: ["summary"] }, 400);

    const now = Date.now();
    // The workspace lookup (a person's active workspace) runs alongside the rate-limit count.
    const recentQuery = db
      .select({
        day: sql<number>`count(*)`,
        hour: sql<number>`coalesce(sum(${schema.feedback.createdAt} > ${now - HOUR_MS}), 0)`,
      })
      .from(schema.feedback)
      .where(
        and(
          eq(schema.feedback.userId, user!.id),
          gt(schema.feedback.createdAt, new Date(now - 24 * HOUR_MS)),
        ),
      );
    const [[recent], about] = await Promise.all([recentQuery, workspace()]);
    const hourly = recent.hour >= FEEDBACK_RATE.hour;
    if (hourly || recent.day >= FEEDBACK_RATE.day) {
      c.header("retry-after", hourly ? "3600" : "86400");
      return c.json({ error: "rate_limited" }, 429);
    }

    const id = crypto.randomUUID();
    const sentAt = new Date(now);
    const { redacted, ...fields } = entry;
    await db.insert(schema.feedback).values({
      id,
      userId: user!.id,
      workspaceId: about?.id ?? null,
      createdAt: sentAt,
      ...fields,
    });

    // emailOperators never throws; only the client lookup can, and then the email goes without a name.
    const emailFeedback = async () => {
      const { clientId } = entry;
      const [client] = clientId
        ? await db
            .select({ name: schema.oauthClient.name })
            .from(schema.oauthClient)
            .where(eq(schema.oauthClient.clientId, clientId))
            .limit(1)
            .catch(() => [])
        : [];
      await emailOperators(c.env, {
        replyTo: user!.email,
        template: "feedback",
        context: {
          id,
          ...entry,
          // A person's message has no category of its own, and wasn't sent by an agent.
          category: entry.source === "agent" ? entry.category : null,
          agent: clientId ? { name: client?.name ?? null } : null,
          user: { name: user!.name, email: user!.email },
          workspaceName: about?.name ?? null,
          sentAt,
        },
      });
    };
    await inBackground(c, emailFeedback());

    return c.json({ id, redacted }, 201);
  },
);

function invalid(c: Context<AppEnv>, error: z.ZodError) {
  const fields = [...new Set(error.issues.map((issue) => issue.path.join(".")))];
  return c.json({ error: "invalid_body", fields }, 400);
}
