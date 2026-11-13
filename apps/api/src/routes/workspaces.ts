import {
  readRetrySettings,
  readRunnerOrder,
  retrySettingsSchema,
  runnerOrderSchema,
} from "@relayrunner/runner-order";
import { and, asc, count, eq, isNotNull, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { agentWorkspaceId } from "../agent-auth.ts";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { isWorkspaceMember } from "../installations.ts";
import { inWorkspace } from "../machines.ts";
import { requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { requireManager } from "../roles.ts";
import { HOSTED_PROVIDER_IDS } from "@relayrunner/providers";
import { present } from "./github.ts";

// Any member of the workspace in the path. Someone outside it gets a 404, so ids don't leak.
// An agent token (agent-auth.ts) only reaches the workspaces it was granted.
const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const workspaceId = c.req.param("id") ?? "";
  if (c.var.agent && agentWorkspaceId(c.var.agent, workspaceId) === null) {
    return c.json({ error: "not_found" }, 404);
  }
  const userId = c.var.user!.id;
  // A miss asks the primary, in case the replica hasn't caught up with a new workspace.
  const membership =
    (await isWorkspaceMember(c.var.db, workspaceId, userId)) ??
    (await isWorkspaceMember(createDb(c.env.DB), workspaceId, userId));
  if (!membership) return c.json({ error: "not_found" }, 404);
  c.set("role", membership.role);
  await next();
});

// Creating, listing and switching workspaces goes through Better Auth's organization endpoints
// (/api/auth/organization/*). This adds the gateway's view of the active workspace.
export const workspaceRoutes = new Hono<AppEnv>()
  .get("/current", requireUser, requireWorkspace, async (c) => {
    const { workspace, role, db } = c.var;
    const installations = await db
      .select()
      .from(schema.githubInstallation)
      .where(eq(schema.githubInstallation.id, workspace.installationId))
      .orderBy(asc(schema.githubInstallation.accountLogin));
    const { runnerOrder: _, ...rest } = workspace;
    return c.json({ workspace: rest, role, installations: installations.map(present) });
  })
  // How many live machines each member owns, keyed by user id, for the Members page (#136).
  // Same filter as GET /api/machines: claimed and not revoked.
  .get("/current/machine-counts", requireUser, requireWorkspace, async (c) => {
    const rows = await c.var.db
      .select({ userId: schema.machine.userId, machines: count() })
      .from(schema.machine)
      .where(
        and(
          inWorkspace(c.var.db, c.var.workspace.id),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
          isNotNull(schema.machine.userId),
        ),
      )
      .groupBy(schema.machine.userId);
    const counts: Record<string, number> = {};
    for (const row of rows) if (row.userId) counts[row.userId] = row.machines;
    return c.json({ counts });
  })
  // The workspace's runner order (#110). Routing reads it from #113 on.
  .get("/:id/runner-order", requireUser, requireMember, async (c) => {
    const [row] = await c.var.db
      .select({ runnerOrder: schema.workspace.runnerOrder })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, c.req.param("id")))
      .limit(1);
    return c.json({ order: readRunnerOrder(row?.runnerOrder), isDefault: !row?.runnerOrder });
  })
  // Owners and admins only; members can read it.
  .put("/:id/runner-order", requireUser, requireMember, requireManager, async (c) => {
    const parsed = runnerOrderSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issues = parsed.error.issues.map(({ path, message }) => ({ path, message }));
      return c.json({ error: "invalid_runner_order", issues }, 400);
    }
    await c.var.db
      .update(schema.workspace)
      .set({ runnerOrder: JSON.stringify(parsed.data) })
      .where(eq(schema.workspace.id, c.req.param("id")));
    return c.json({ order: parsed.data, isDefault: false });
  })
  // Whether the Router skips hosted provider runner types that stopped picking up jobs, and the
  // ones it skips now (src/provider-health.ts).
  .get("/:id/provider-health", requireUser, requireMember, async (c) => {
    const id = c.req.param("id");
    const [[row], unhealthy] = await Promise.all([
      c.var.db
        .select({ enabled: schema.workspace.skipUnhealthyRunners })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, id))
        .limit(1),
      c.env.ROUTER.getByName(id).unhealthy(),
    ]);
    return c.json({ enabled: row?.enabled ?? true, unhealthy });
  })
  // Turns skipping on or off. Owners and admins, like the order.
  .put("/:id/provider-health", requireUser, requireMember, requireManager, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") return c.json({ error: "invalid_body" }, 400);
    await c.var.db
      .update(schema.workspace)
      .set({ skipUnhealthyRunners: body.enabled })
      .where(eq(schema.workspace.id, c.req.param("id")));
    return c.json({ enabled: body.enabled });
  })
  // Automatic retries of jobs whose runner failed them (src/retries.ts). Off until turned on.
  .get("/:id/retry-settings", requireUser, requireMember, async (c) => {
    const [row] = await c.var.db
      .select({ settings: schema.workspace.retrySettings })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, c.req.param("id")))
      .limit(1);
    return c.json(readRetrySettings(row?.settings));
  })
  // Owners and admins, like the order.
  .put("/:id/retry-settings", requireUser, requireMember, requireManager, async (c) => {
    const parsed = retrySettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    await c.var.db
      .update(schema.workspace)
      .set({ retrySettings: JSON.stringify(parsed.data) })
      .where(eq(schema.workspace.id, c.req.param("id")));
    return c.json(parsed.data);
  })
  // "Try again now": jobs go to the runner type again. Owners and admins, like the order.
  .delete(
    "/:id/provider-health/:key/:label",
    requireUser,
    requireMember,
    requireManager,
    async (c) => {
      const key = c.req.param("key");
      if (!(HOSTED_PROVIDER_IDS as readonly string[]).includes(key))
        return c.json({ error: "unknown_provider" }, 400);
      await c.env.ROUTER.getByName(c.req.param("id")).clearHealth(key, c.req.param("label"));
      return c.json({ cleared: true });
    },
  );
