import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { AGENT_WORKSPACE_HEADER, agentWorkspaceId } from "../agent-auth.ts";
import { createDb, schema, type Db } from "../db/index.ts";
import { AppError } from "@relayrunner/errors";
import { annotate } from "../tracing.ts";

// Resolves the session's active workspace and the signed-in user's membership in it. Gateway
// routes that act on a workspace (installations, machines, repos) go behind this. Run it after
// requireUser.
// An agent token (agent-auth.ts) reads the granted workspace it asked for instead of an active one,
// and changes it only where it's allowed changes.
export const requireWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  const { agent } = c.var;
  const workspaceId = agent
    ? agentWorkspaceId(agent, c.req.header(AGENT_WORKSPACE_HEADER), c.req.method)
    : c.var.session?.activeOrganizationId;
  if (!workspaceId) {
    throw new AppError(agent ? "WORKSPACE_REQUIRED" : "NO_ACTIVE_WORKSPACE");
  }
  annotate({ "relayrunner.workspace_id": workspaceId });

  const userId = c.var.user!.id;
  // A workspace an install made a moment ago may not be on a replica yet, so a miss asks the primary.
  const row =
    (await membership(c.var.db, workspaceId, userId)) ??
    (await membership(createDb(c.env.DB), workspaceId, userId));
  // A stale active id (workspace deleted, or membership removed) reads as no workspace.
  if (!row) throw new AppError("NO_ACTIVE_WORKSPACE");

  c.set("workspace", row.workspace);
  c.set("role", row.role);
  await next();
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
