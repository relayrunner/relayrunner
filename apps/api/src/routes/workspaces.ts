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
import { HOSTED_PROVIDER_IDS, providersOfAppSlugs } from "@relayrunner/providers";
import { appInstallationToken, orgAppSlugs } from "../github-app.ts";
import { present } from "./github.ts";
import { AppError } from "@relayrunner/errors";
import { annotate } from "../tracing.ts";
import { routerSetup } from "../router-setup.ts";
import { DEFAULT_AUTO_SIZE } from "@relayrunner/providers";
import { setWorkspaceAi } from "../ai/settings.ts";
import { autoJobSettingSchema, autoSizeSchema, listAutoJobs, setAutoJob } from "../auto-jobs.ts";

// Any member of the workspace in the path. Someone outside it gets a 404, so ids don't leak.
// An agent token (agent-auth.ts) only reaches the workspaces it was granted.
const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const workspaceId = c.req.param("id") ?? "";
  annotate({ "relayrunner.workspace_id": workspaceId });
  if (c.var.agent && agentWorkspaceId(c.var.agent, workspaceId) === null) {
    throw new AppError("NOT_FOUND");
  }
  const userId = c.var.user!.id;
  // A miss asks the primary, in case the replica hasn't caught up with a new workspace.
  const membership =
    (await isWorkspaceMember(c.var.db, workspaceId, userId)) ??
    (await isWorkspaceMember(createDb(c.env.DB), workspaceId, userId));
  if (!membership) throw new AppError("NOT_FOUND");
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
    // Right after installing on an org, the Setup URL usually lands before GitHub's
    // `installation.created` webhook, which is what names the installer as owner (#317). Until it
    // does, the installer reads as a member. Saying so lets the dashboard wait for it.
    const ownerPending =
      role === "member" &&
      installations.some((row) => row.accountType === "Organization" && !row.installerGithubId);
    return c.json({
      workspace: rest,
      role,
      ownerPending,
      installations: installations.map(present),
    });
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
      throw new AppError("RUNNER_ORDER_INVALID", {
        message: issues[0]?.message,
        details: { issues },
      });
    }
    await c.var.db
      .update(schema.workspace)
      .set({ runnerOrder: JSON.stringify(parsed.data) })
      .where(eq(schema.workspace.id, c.req.param("id")));
    return c.json({ order: parsed.data, isDefault: false });
  })
  // Which hosted providers' GitHub Apps the workspace's org has installed, for the Router's Add
  // step menu. Null when we can't tell: a personal account (GitHub only lists an org's apps), or
  // the read failed.
  .get("/:id/provider-apps", requireUser, requireMember, async (c) => {
    const [row] = await c.var.db
      .select({
        installationId: schema.githubInstallation.id,
        login: schema.githubInstallation.accountLogin,
        type: schema.githubInstallation.accountType,
      })
      .from(schema.workspace)
      .innerJoin(
        schema.githubInstallation,
        eq(schema.githubInstallation.id, schema.workspace.installationId),
      )
      .where(eq(schema.workspace.id, c.req.param("id")))
      .limit(1);
    if (row?.type !== "Organization") return c.json({ installed: null });
    try {
      const token = await appInstallationToken(c.env, row.installationId);
      return c.json({ installed: providersOfAppSlugs(await orgAppSlugs(token, row.login)) });
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "provider apps read failed",
          installationId: row.installationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return c.json({ installed: null });
    }
  })
  // The Router page's setup panel: recent workflows, routed or not, and the hosted labels jobs
  // ran on (src/router-setup.ts).
  .get("/:id/router-setup", requireUser, requireMember, async (c) =>
    c.json(await routerSetup(c.var.db, c.req.param("id"))),
  )
  // Jobs whose relay hands their runner to the Router (`auto`), with the size and first provider
  // set for each, and the workspace's default size (src/auto-jobs.ts).
  .get("/:id/auto-jobs", requireUser, requireMember, async (c) => {
    const id = c.req.param("id");
    const [[row], jobs] = await Promise.all([
      c.var.db
        .select({ size: schema.workspace.autoSize })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, id))
        .limit(1),
      listAutoJobs(c.var.db, id),
    ]);
    return c.json({ size: row?.size ?? DEFAULT_AUTO_SIZE, jobs });
  })
  // The default size for auto jobs. Owners and admins, like the order.
  .put("/:id/auto-size", requireUser, requireMember, requireManager, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { size?: unknown } | null;
    const parsed = autoSizeSchema.safeParse(body?.size);
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    await c.var.db
      .update(schema.workspace)
      .set({ autoSize: parsed.data })
      .where(eq(schema.workspace.id, c.req.param("id")));
    return c.json({ size: parsed.data });
  })
  // One auto job's size and the provider it tries first. Owners and admins, like the order.
  .put("/:id/auto-jobs/:jobId", requireUser, requireMember, requireManager, async (c) => {
    const parsed = autoJobSettingSchema.safeParse(await c.req.json().catch(() => null));
    const jobId = Number(c.req.param("jobId"));
    if (!parsed.success || !Number.isSafeInteger(jobId)) throw new AppError("INVALID_REQUEST");
    const found = await setAutoJob(c.var.db, c.req.param("id"), jobId, parsed.data, c.var.user!.id);
    if (!found) throw new AppError("NOT_FOUND");
    return c.json(parsed.data);
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
    if (typeof body?.enabled !== "boolean") throw new AppError("INVALID_REQUEST");
    await c.var.db
      .update(schema.workspace)
      .set({ skipUnhealthyRunners: body.enabled })
      .where(eq(schema.workspace.id, c.req.param("id")));
    return c.json({ enabled: body.enabled });
  })
  // When the workspace turned off AI features (src/ai), or null while they're on (the default).
  .get("/:id/ai", requireUser, requireMember, async (c) => {
    const [row] = await c.var.db
      .select({ offAt: schema.workspace.aiOffAt })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, c.req.param("id")))
      .limit(1);
    return c.json({ offAt: row?.offAt ?? null });
  })
  // Turns AI on or off. Owners and admins, like the order.
  .put("/:id/ai", requireUser, requireMember, requireManager, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") throw new AppError("INVALID_REQUEST");
    await setWorkspaceAi(c.var.db, c.req.param("id"), body.enabled, c.var.user!.id);
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
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
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
        throw new AppError("PROVIDER_UNKNOWN");
      await c.env.ROUTER.getByName(c.req.param("id")).clearHealth(key, c.req.param("label"));
      return c.json({ cleared: true });
    },
  );
