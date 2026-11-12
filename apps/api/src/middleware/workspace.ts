import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { AGENT_WORKSPACE_HEADER, agentWorkspaceId } from "../agent-auth.ts";
import { createDb, schema, type Db } from "../db/index.ts";
import { sessionDb } from "./d1-session.ts";

// Resolves the session's active workspace and the signed-in user's membership in it. Gateway
// routes that act on a workspace (installations, machines, repos) go behind this. Run it after
// requireUser.
// An agent token (agent-auth.ts) reads the granted workspace it asked for instead of an active one.
export const requireWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  const { agent } = c.var;
  const workspaceId = agent
    ? agentWorkspaceId(agent, c.req.header(AGENT_WORKSPACE_HEADER))
    : c.var.session?.activeOrganizationId;
  if (!workspaceId) {
    return c.json({ error: agent ? "workspace_required" : "no_active_workspace" }, 409);
  }

  // On the primary: a workspace made by an install a moment ago may not be on a replica yet.
  const row = await membership(createDb(c.env.DB), workspaceId, c.var.user!.id);
  // A stale active id (workspace deleted, or membership removed) reads as no workspace.
  if (!row) return c.json({ error: "no_active_workspace" }, 409);

  const { db, saveBookmark } = sessionDb(c);
  c.set("db", db);
  c.set("workspace", row.workspace);
  c.set("role", row.role);
  await next();
  saveBookmark();
});

/** The workspace and the user's role in it, or null when they aren't a member (or it's gone). */
export async function membership(db: Db, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ workspace: schema.workspace, role: schema.workspaceMember.role })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    .where(
      and(
        eq(schema.workspaceMember.workspaceId, workspaceId),
        eq(schema.workspaceMember.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}
