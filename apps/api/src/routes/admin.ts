/**
 * Operator admin over D1: every user and workspace, and who is an operator. Needs Cloudflare Access
 * (app.ts) and an operator session. Grant the first operator with SQL
 * (docs/cloudflare-access.md); after that, operators grant each other here. The deletes are for
 * repeating new-user signup and onboarding tests (src/admin-delete.ts).
 */
import { count, desc, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { deleteUser, deleteWorkspaces } from "../admin-delete.ts";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { requireOperator, who } from "../middleware/admin.ts";
import { requireUser } from "../middleware/session.ts";
import { adminPriceRoutes } from "./admin-prices.ts";
import { USER_ROLES } from "../roles.ts";

const RoleBody = z.object({ role: z.enum(USER_ROLES).nullable() });
const DeleteBody = z.object({ uninstallGitHubApp: z.boolean().default(false) });

async function deleteOptions(request: Request) {
  // A body is optional; without one nothing is uninstalled.
  const text = await request.text();
  return DeleteBody.safeParse(text ? JSON.parse(text) : {});
}

export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireOperator)
  .route("/prices", adminPriceRoutes)
  .get("/users", async (c) => {
    const db = createDb(c.env.DB);
    const users = await db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        image: schema.user.image,
        role: schema.user.role,
        createdAt: schema.user.createdAt,
        workspaces: count(schema.workspaceMember.id),
      })
      .from(schema.user)
      .leftJoin(schema.workspaceMember, eq(schema.workspaceMember.userId, schema.user.id))
      .groupBy(schema.user.id)
      .orderBy(desc(schema.user.createdAt));
    return c.json({ users });
  })
  .patch("/users/:id", async (c) => {
    const parsed = RoleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_role" }, 400);
    const id = c.req.param("id");
    // Keeps at least the caller an operator, so nobody locks the last one out by accident.
    if (id === c.var.user!.id && parsed.data.role !== "operator") {
      return c.json({ error: "cannot_demote_self" }, 400);
    }
    const [updated] = await createDb(c.env.DB)
      .update(schema.user)
      .set({ role: parsed.data.role })
      .where(eq(schema.user.id, id))
      .returning({ id: schema.user.id, role: schema.user.role });
    if (!updated) return c.json({ error: "not_found" }, 404);
    console.log(
      JSON.stringify({
        msg: "user role changed",
        by: c.var.user!.email,
        access: who(c.var.accessIdentity),
        userId: id,
        role: updated.role,
      }),
    );
    return c.json({ user: updated });
  })
  .delete("/users/:id", async (c) => {
    const options = await deleteOptions(c.req.raw).catch(() => null);
    if (!options?.success) return c.json({ error: "invalid_body" }, 400);
    const id = c.req.param("id");
    if (id === c.var.user!.id) return c.json({ error: "cannot_delete_self" }, 400);
    const result = await deleteUser(c.env, createDb(c.env.DB), id, options.data);
    if (!result.ok) {
      if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
      return c.json({ error: result.error, workspaces: result.workspaces }, 409);
    }
    console.log(
      JSON.stringify({
        msg: "user deleted",
        by: c.var.user!.email,
        access: who(c.var.accessIdentity),
        userId: id,
        workspaces: result.workspaces,
      }),
    );
    return c.json({ workspaces: result.workspaces });
  })
  .delete("/workspaces/:id", async (c) => {
    const options = await deleteOptions(c.req.raw).catch(() => null);
    if (!options?.success) return c.json({ error: "invalid_body" }, 400);
    const id = c.req.param("id");
    const [deleted] = await deleteWorkspaces(c.env, createDb(c.env.DB), [id], options.data);
    if (!deleted) return c.json({ error: "not_found" }, 404);
    console.log(
      JSON.stringify({
        msg: "workspace deleted",
        by: c.var.user!.email,
        access: who(c.var.accessIdentity),
        workspace: deleted,
      }),
    );
    return c.json({ workspace: deleted });
  })
  .get("/workspaces", async (c) => {
    const db = createDb(c.env.DB);
    const [workspaces, members, installations] = await Promise.all([
      db.select().from(schema.workspace).orderBy(desc(schema.workspace.createdAt)),
      db
        .select({
          workspaceId: schema.workspaceMember.workspaceId,
          userId: schema.user.id,
          name: schema.user.name,
          email: schema.user.email,
          role: schema.workspaceMember.role,
        })
        .from(schema.workspaceMember)
        .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId)),
      db
        .select({
          workspaceId: schema.githubInstallation.workspaceId,
          accountLogin: schema.githubInstallation.accountLogin,
        })
        .from(schema.githubInstallation)
        .where(isNotNull(schema.githubInstallation.workspaceId)),
    ]);
    const membersOf = Map.groupBy(members, (member) => member.workspaceId);
    const accountsOf = Map.groupBy(installations, (installation) => installation.workspaceId);
    return c.json({
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt,
        members: membersOf.get(workspace.id) ?? [],
        githubAccounts: (accountsOf.get(workspace.id) ?? []).map((i) => i.accountLogin),
      })),
    });
  });
