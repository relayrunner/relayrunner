/**
 * Operator deletes of workspaces and users, for repeating new-user signup and onboarding tests
 * (routes/admin.ts). Not a user-facing feature: nothing outside /api/admin calls these.
 *
 * D1's foreign keys do most of the work (members, invites, machines, activity, route decisions,
 * sessions, sign-in accounts, device codes). This adds what they can't reach: Durable Object
 * storage, other users' active-workspace pointers, RelayRunner's label on adopted GitHub runners,
 * and, when asked, the GitHub App installation itself.
 */
import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db/index.ts";
import { schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { deleteInstallation } from "./github-app.ts";
import { removeRoutingLabel } from "./machines.ts";

export type DeleteOptions = {
  /** Also uninstall the App from the workspaces' GitHub accounts and drop their install rows. */
  uninstallGitHubApp: boolean;
};

export type DeletedWorkspace = {
  id: string;
  name: string;
  machines: number;
  /** Accounts the App was uninstalled from. */
  uninstalled: string[];
  /** Accounts left connected but unclaimed (uninstallGitHubApp was off). */
  unclaimed: string[];
};

export async function deleteWorkspaces(
  env: Env,
  db: Db,
  workspaceIds: string[],
  options: DeleteOptions,
): Promise<DeletedWorkspace[]> {
  if (!workspaceIds.length) return [];
  const [workspaces, machines, installations] = await Promise.all([
    db.select().from(schema.workspace).where(inArray(schema.workspace.id, workspaceIds)),
    db.select().from(schema.machine).where(inArray(schema.machine.workspaceId, workspaceIds)),
    db
      .select()
      .from(schema.githubInstallation)
      .where(inArray(schema.githubInstallation.workspaceId, workspaceIds)),
  ]);
  if (!workspaces.length) return [];
  const ids = workspaces.map((workspace) => workspace.id);

  // While the install rows still exist: take our label off adopted runners, close machine sockets
  // and wipe the Durable Objects nothing will call again.
  for (const machine of machines) {
    if (machine.source === "github" && !machine.revokedAt)
      await removeRoutingLabel(env, db, machine);
  }
  await Promise.all([
    ...machines.map((machine) => env.MACHINE_LINK.getByName(machine.id).purge()),
    ...ids.map((id) => env.ROUTER.getByName(id).purge()),
  ]);

  const uninstalled: typeof installations = [];
  if (options.uninstallGitHubApp) {
    for (const installation of installations) {
      await deleteInstallation(env, installation.id);
      uninstalled.push(installation);
    }
    // Repos, jobs, timings, runs and usage go with the rows. The uninstall webhook that follows
    // finds nothing left to delete.
    if (uninstalled.length)
      await db.delete(schema.githubInstallation).where(
        inArray(
          schema.githubInstallation.id,
          uninstalled.map((installation) => installation.id),
        ),
      );
  }

  // No foreign key on session.active_workspace_id.
  await db
    .update(schema.session)
    .set({ activeWorkspaceId: null })
    .where(inArray(schema.session.activeWorkspaceId, ids));
  await db.delete(schema.workspace).where(inArray(schema.workspace.id, ids));

  return workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    machines: machines.filter((machine) => machine.workspaceId === workspace.id).length,
    uninstalled: uninstalled
      .filter((installation) => installation.workspaceId === workspace.id)
      .map((installation) => installation.accountLogin),
    unclaimed: options.uninstallGitHubApp
      ? []
      : installations
          .filter((installation) => installation.workspaceId === workspace.id)
          .map((installation) => installation.accountLogin),
  }));
}

export type DeleteUserResult =
  | { ok: true; workspaces: DeletedWorkspace[] }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "shared_workspaces"; workspaces: { id: string; name: string }[] };

/**
 * Deletes a user and every workspace they're the only member of. Refuses, changing nothing, when
 * they share a workspace with anyone else, so a real team is never wiped by accident.
 */
export async function deleteUser(
  env: Env,
  db: Db,
  userId: string,
  options: DeleteOptions,
): Promise<DeleteUserResult> {
  const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  if (!user) return { ok: false, error: "not_found" };

  const memberships = await db
    .select({ workspaceId: schema.workspaceMember.workspaceId })
    .from(schema.workspaceMember)
    .where(eq(schema.workspaceMember.userId, userId));
  const workspaceIds = memberships.map((membership) => membership.workspaceId);
  const members = workspaceIds.length
    ? await db
        .select({
          workspaceId: schema.workspaceMember.workspaceId,
          userId: schema.workspaceMember.userId,
          name: schema.workspace.name,
        })
        .from(schema.workspaceMember)
        .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
        .where(inArray(schema.workspaceMember.workspaceId, workspaceIds))
    : [];
  const shared = new Map<string, string>();
  for (const member of members) {
    if (member.userId !== userId) shared.set(member.workspaceId, member.name);
  }
  if (shared.size) {
    return {
      ok: false,
      error: "shared_workspaces",
      workspaces: [...shared].map(([id, name]) => ({ id, name })),
    };
  }

  const workspaces = await deleteWorkspaces(env, db, workspaceIds, options);
  // Sessions, sign-in accounts, device codes, memberships and invites they sent cascade.
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  return { ok: true, workspaces };
}
