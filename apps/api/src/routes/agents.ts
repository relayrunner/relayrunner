import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { pendingGrant } from "../agent-auth.ts";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";

const GrantBody = z.object({ workspaceIds: z.array(z.string().min(1)).min(1).max(100) });

// The signed-in user's connected agents (MCP clients, agent-auth.ts). POST /grants is the
// workspace picker's step in agent sign-in, and GET /grants/pending what the consent page names. The list and disconnect are Settings → Agents in the
// active workspace: disconnecting takes this workspace out of the agent's grant, at once. When that
// was its last workspace, it also deletes the consent and revokes the client's refresh tokens.
export const agentRoutes = new Hono<AppEnv>()
  .post("/grants", requireUser, async (c) => {
    const session = c.var.session;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const parsed = GrantBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const workspaceIds = [...new Set(parsed.data.workspaceIds)];
    const db = createDb(c.env.DB);
    const memberships = await db
      .select({ id: schema.workspaceMember.workspaceId })
      .from(schema.workspaceMember)
      .where(
        and(
          eq(schema.workspaceMember.userId, c.var.user!.id),
          inArray(schema.workspaceMember.workspaceId, workspaceIds),
        ),
      );
    if (memberships.length !== workspaceIds.length) return c.json({ error: "not_found" }, 404);
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(schema.agentGrant).values({ id, userId: c.var.user!.id, sessionId: session.id }),
      db
        .insert(schema.agentGrantWorkspace)
        .values(workspaceIds.map((workspaceId) => ({ grantId: id, workspaceId }))),
    ]);
    return c.json({ id }, 201);
  })
  .get("/grants/pending", requireUser, async (c) => {
    const db = createDb(c.env.DB);
    const grantId = await pendingGrant(db, c.var.session?.id, c.var.user!.id);
    if (!grantId) return c.json({ error: "not_found" }, 404);
    const workspaces = await db
      .select({ id: schema.workspace.id, name: schema.workspace.name })
      .from(schema.agentGrantWorkspace)
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.agentGrantWorkspace.workspaceId))
      .where(eq(schema.agentGrantWorkspace.grantId, grantId))
      .orderBy(schema.workspace.name);
    return c.json({ workspaces });
  })
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
      .innerJoin(
        schema.agentGrantWorkspace,
        and(
          eq(schema.agentGrantWorkspace.grantId, schema.oauthConsent.referenceId),
          eq(schema.agentGrantWorkspace.workspaceId, c.var.workspace.id),
        ),
      )
      .where(eq(schema.oauthConsent.userId, c.var.user!.id))
      .orderBy(desc(schema.oauthConsent.createdAt));
    return c.json({ mcpUrl: c.env.AGENTS_MCP_URL, agents: rows });
  })
  .delete("/:id", requireUser, requireWorkspace, async (c) => {
    const { db, workspace } = c.var;
    const userId = c.var.user!.id;
    const mine = and(
      eq(schema.oauthConsent.id, c.req.param("id")),
      eq(schema.oauthConsent.userId, userId),
    );
    const [consent] = await db
      .select({ clientId: schema.oauthConsent.clientId, grantId: schema.oauthConsent.referenceId })
      .from(schema.oauthConsent)
      .innerJoin(
        schema.agentGrantWorkspace,
        and(
          eq(schema.agentGrantWorkspace.grantId, schema.oauthConsent.referenceId),
          eq(schema.agentGrantWorkspace.workspaceId, workspace.id),
        ),
      )
      .where(mine)
      .limit(1);
    if (!consent?.grantId) return c.json({ error: "not_found" }, 404);
    const { grantId } = consent;
    const [[{ left }]] = await db.batch([
      db
        .select({ left: count() })
        .from(schema.agentGrantWorkspace)
        .where(eq(schema.agentGrantWorkspace.grantId, grantId)),
      db
        .delete(schema.agentGrantWorkspace)
        .where(
          and(
            eq(schema.agentGrantWorkspace.grantId, grantId),
            eq(schema.agentGrantWorkspace.workspaceId, workspace.id),
          ),
        ),
    ]);
    if (left <= 1) {
      await db.batch([
        db
          .update(schema.oauthRefreshToken)
          .set({ revoked: new Date() })
          .where(
            and(
              eq(schema.oauthRefreshToken.userId, userId),
              eq(schema.oauthRefreshToken.clientId, consent.clientId),
              eq(schema.oauthRefreshToken.referenceId, grantId),
              isNull(schema.oauthRefreshToken.revoked),
            ),
          ),
        db.delete(schema.oauthConsent).where(mine),
        db.delete(schema.agentGrant).where(eq(schema.agentGrant.id, grantId)),
      ]);
    }
    return c.json({ ok: true });
  });
