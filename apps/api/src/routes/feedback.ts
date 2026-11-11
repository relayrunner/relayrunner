import { and, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AGENT_WORKSPACE_HEADER, agentWorkspaceId } from "../agent-auth.ts";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { sendEmail } from "../email.ts";
import { FEEDBACK_CATEGORIES, FEEDBACK_LIMITS } from "@relayrunner/activity";
import { FEEDBACK_RATE, sanitizeFeedback } from "../feedback.ts";
import { inBackground, requireUser } from "../middleware/session.ts";

// Raw input may run a little over the stored limits (whitespace, invisible characters) before
// cleaning trims it; anything far over is refused rather than silently cut.
const slack = (max: number) => Math.ceil(max * 1.25);
const FeedbackBody = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  summary: z.string().min(1).max(slack(FEEDBACK_LIMITS.summary)),
  details: z.string().max(slack(FEEDBACK_LIMITS.details)).optional(),
  tool: z.string().max(FEEDBACK_LIMITS.tool).optional(),
});

const HOUR_MS = 60 * 60 * 1000;

// Feedback from agents (the MCP server's send_feedback tool). Agent tokens only: it records which
// agent sent it and, when the request names one of its workspaces, which workspace it's about.
// The answer never repeats what was sent, so a secret the redaction missed isn't echoed back.
export const feedbackRoutes = new Hono<AppEnv>().post(
  "/",
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }),
  requireUser,
  async (c) => {
    const { agent, user } = c.var;
    if (!agent) return c.json({ error: "agents_only" }, 403);
    const requested = c.req.header(AGENT_WORKSPACE_HEADER);
    const workspaceId = agentWorkspaceId(agent, requested);
    if (requested && !workspaceId) return c.json({ error: "not_found" }, 404);

    const parsed = FeedbackBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
      return c.json({ error: "invalid_body", fields }, 400);
    }
    const feedback = sanitizeFeedback(parsed.data);
    if (!feedback.summary) return c.json({ error: "invalid_body", fields: ["summary"] }, 400);

    const db = createDb(c.env.DB);
    const now = Date.now();
    const [recent] = await db
      .select({
        day: sql<number>`count(*)`,
        hour: sql<number>`coalesce(sum(${schema.agentFeedback.createdAt} > ${now - HOUR_MS}), 0)`,
      })
      .from(schema.agentFeedback)
      .where(
        and(
          eq(schema.agentFeedback.userId, user!.id),
          gt(schema.agentFeedback.createdAt, new Date(now - 24 * HOUR_MS)),
        ),
      );
    const hourly = recent.hour >= FEEDBACK_RATE.hour;
    if (hourly || recent.day >= FEEDBACK_RATE.day) {
      c.header("retry-after", hourly ? "3600" : "86400");
      return c.json({ error: "rate_limited" }, 429);
    }

    const id = crypto.randomUUID();
    const { redacted, ...row } = feedback;
    const sentAt = new Date(now);
    await db.insert(schema.agentFeedback).values({
      id,
      userId: user!.id,
      workspaceId,
      grantId: agent.grantId,
      clientId: agent.clientId,
      createdAt: sentAt,
      ...row,
    });

    const to = c.env.FEEDBACK_EMAIL;
    if (to) {
      // sendEmail never throws; only the client lookup can, and then the email goes without a name.
      const emailFeedback = async () => {
        const [client] = await db
          .select({ name: schema.oauthClient.name })
          .from(schema.oauthClient)
          .where(eq(schema.oauthClient.clientId, agent.clientId))
          .limit(1)
          .catch(() => []);
        await sendEmail(c.env, {
          to,
          replyTo: user!.email,
          template: "agent-feedback",
          context: {
            id,
            ...feedback,
            user: { name: user!.name, email: user!.email },
            workspaceName: agent.workspaces.find((w) => w.id === workspaceId)?.name ?? null,
            clientName: client?.name ?? null,
            sentAt,
          },
        });
      };
      await inBackground(c, emailFeedback());
    }

    return c.json({ id, redacted }, 201);
  },
);
