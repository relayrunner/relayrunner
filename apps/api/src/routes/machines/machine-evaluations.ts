import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AppError } from "@relayrunner/errors";
import { schema } from "../../db/index.ts";
import type { MachineEnv } from "../../middleware/machine.ts";
import { chooseWorkspace } from "../../providers/provider-connections.ts";
import { evaluationHandlers } from "../evaluations.ts";

// `relayrunner eval`: the dashboard's evaluation routes (routes/evaluations.ts), called with the
// machine's token as the machine's owner. The token lives on the owner's computer, so it acts as
// them, as `relayrunner blacksmith connect` does, with their role in the workspace: any member
// looks, owners and admins start and stop.
//
// `?workspace=` (an id, slug or name) names the workspace. Without it, `?owner=` (the GitHub
// account of the repo the CLI runs in) picks the workspace installed there, else the owner's only
// one. Any of the owner's workspaces works, not only the ones the machine takes jobs in.

/** Sets c.var.user, c.var.workspace and c.var.role for the machine's owner. */
const asOwner = createMiddleware<MachineEnv>(async (c, next) => {
  const { machine, machineDb: db } = c.var;
  if (!machine.userId) throw new AppError("MACHINE_NOT_OWNED");
  const [user] = await db.select().from(schema.user).where(eq(schema.user.id, machine.userId));
  if (!user) throw new AppError("MACHINE_NOT_OWNED");
  const rows = await db
    .select({
      workspace: schema.workspace,
      role: schema.workspaceMember.role,
      accountLogin: schema.githubInstallation.accountLogin,
    })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    .leftJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .where(eq(schema.workspaceMember.userId, machine.userId))
    .orderBy(schema.workspaceMember.createdAt, schema.workspace.id);
  const choices = rows.map((row) => ({
    id: row.workspace.id,
    name: row.workspace.name,
    slug: row.workspace.slug,
    accountLogin: row.accountLogin,
  }));
  const wanted = c.req.query("workspace") || undefined;
  const chosen =
    chooseWorkspace(choices, c.req.query("owner") || undefined, wanted) ??
    (!wanted && choices.length === 1 ? choices[0]! : null);
  const row = chosen && rows.find((r) => r.workspace.id === chosen.id);
  if (!row)
    throw new AppError(wanted ? "NOT_FOUND" : "EVALUATION_WORKSPACE_UNCLEAR", {
      details: { workspaces: choices.map(({ id, name, slug }) => ({ id, name, slug })) },
    });
  c.set("user", user);
  c.set("workspace", row.workspace);
  c.set("role", row.role);
  await next();
});

export const machineEvaluationRoutes = new Hono<MachineEnv>()
  .use("*", asOwner)
  .route("/", evaluationHandlers);
