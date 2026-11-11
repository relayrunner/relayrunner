import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";

// Resolves the session's active workspace and the signed-in user's membership in it. Gateway
// routes that act on a workspace (installations, machines, repos) go behind this. Run it after
// requireUser.
// An agent token (agent-auth.ts) reads the workspace it was granted instead of an active one.
export const requireWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  const workspaceId = c.var.agent?.workspaceId ?? c.var.session?.activeOrganizationId;
  if (!workspaceId) return c.json({ error: "no_active_workspace" }, 409);

  const db = createDb(c.env.DB);
  const [row] = await db
    .select({ workspace: schema.workspace, role: schema.workspaceMember.role })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    .where(
      and(
        eq(schema.workspaceMember.workspaceId, workspaceId),
        eq(schema.workspaceMember.userId, c.var.user!.id),
      ),
    )
    .limit(1);
  // A stale active id (workspace deleted, or membership removed) reads as no workspace.
  if (!row) return c.json({ error: "no_active_workspace" }, 409);

  c.set("db", db);
  c.set("workspace", row.workspace);
  c.set("role", row.role);
  await next();
});
