import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { schema } from "../db/index.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";

// The signed-in user's connected agents (MCP clients, agent-auth.ts) in the active workspace, for
// Settings → Agents. Disconnecting deletes the consent and revokes the client's refresh tokens for
// this workspace; its last access token stops working when it expires, within 15 minutes.
export const agentRoutes = new Hono<AppEnv>()
  .get("/", requireUser, requireWorkspace, async (c) => {
    const rows = await c.var.db
      .select({
        id: schema.oauthConsent.id,
        clientName: schema.oauthClient.name,
        clientUri: schema.oauthClient.uri,
        connectedAt: schema.oauthConsent.createdAt,
      })
      .from(schema.oauthConsent)
      .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
      .where(
        and(
          eq(schema.oauthConsent.userId, c.var.user!.id),
          eq(schema.oauthConsent.referenceId, c.var.workspace.id),
        ),
      )
      .orderBy(desc(schema.oauthConsent.createdAt));
    return c.json({ mcpUrl: c.env.AGENTS_MCP_URL, agents: rows });
  })
  .delete("/:id", requireUser, requireWorkspace, async (c) => {
    const mine = and(
      eq(schema.oauthConsent.id, c.req.param("id")),
      eq(schema.oauthConsent.userId, c.var.user!.id),
      eq(schema.oauthConsent.referenceId, c.var.workspace.id),
    );
    const [consent] = await c.var.db
      .select({ clientId: schema.oauthConsent.clientId })
      .from(schema.oauthConsent)
      .where(mine)
      .limit(1);
    if (!consent) return c.json({ error: "not_found" }, 404);
    await c.var.db.batch([
      c.var.db
        .update(schema.oauthRefreshToken)
        .set({ revoked: new Date() })
        .where(
          and(
            eq(schema.oauthRefreshToken.userId, c.var.user!.id),
            eq(schema.oauthRefreshToken.clientId, consent.clientId),
            eq(schema.oauthRefreshToken.referenceId, c.var.workspace.id),
            isNull(schema.oauthRefreshToken.revoked),
          ),
        ),
      c.var.db.delete(schema.oauthConsent).where(mine),
    ]);
    return c.json({ ok: true });
  });
