/**
 * Operator deletes of workspaces and users, for repeating new-user signup and onboarding tests
 * (routes/admin.ts). Not a user-facing feature: nothing outside /api/admin calls these.
 *
 * D1's foreign keys do most of the work (a workspace goes with its installation, and members,
 * invites, machines, activity, route decisions, sessions, sign-in accounts and device codes with
 * theirs). This adds what they can't reach: Durable Object storage, other users' active-workspace
 * pointers, RelayRunner's label on adopted GitHub runners, and, when asked, the GitHub App
 * installation itself.
 */
import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db/index.ts";
import { schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { deleteInstallation } from "./github-app.ts";
import { removeRoutingLabel } from "./machines.ts";

export type DeleteOptions = {
  /** Also uninstall the App from the workspaces' GitHub accounts. */
  uninstallGitHubApp: boolean;
};

export type DeletedWorkspace = {
  id: string;
  name: string;
  machines: number;
  /** Accounts the App was uninstalled from. */
  uninstalled: string[];
  /**
   * Accounts forgotten but still installed (uninstallGitHubApp was off). GitHub's next
   * installation webhook, or the installer's next visit to the Setup URL, makes them again.
   */
  forgotten: string[];
};

/**
 * Deletes workspaces. A workspace is its installation (#316), so this forgets the installation:
 * its row goes, and with it the workspace, repos, jobs, timings, runs and usage.
 */
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
      .select({
        id: schema.githubInstallation.id,
        accountLogin: schema.githubInstallation.accountLogin,
        workspaceId: schema.workspace.id,
      })
      .from(schema.githubInstallation)
      .innerJoin(
        schema.workspace,
        eq(schema.workspace.installationId, schema.githubInstallation.id),
      )
      .where(inArray(schema.workspace.id, workspaceIds)),
  ]);
  if (!workspaces.length) return [];

  // While the install is still there: take our label off adopted runners.
  for (const machine of machines) {
    if (machine.source === "github" && !machine.revokedAt)
      await removeRoutingLabel(env, db, machine);
  }
  if (options.uninstallGitHubApp) {
    // The uninstall webhook that follows finds nothing left to delete.
    for (const installation of installations) await deleteInstallation(env, installation.id);
  }
  await forgetWorkspaces(
    env,
    db,
    workspaces.map((workspace) => workspace.id),
    machines,
  );

  return workspaces.map((workspace) => {
    const accounts = installations
      .filter((installation) => installation.workspaceId === workspace.id)
      .map((installation) => installation.accountLogin);
    return {
      id: workspace.id,
      name: workspace.name,
      machines: machines.filter((machine) => machine.workspaceId === workspace.id).length,
      uninstalled: options.uninstallGitHubApp ? accounts : [],
      forgotten: options.uninstallGitHubApp ? [] : accounts,
    };
  });
}

/**
 * The App was uninstalled (the `installation.deleted` webhook): delete the installation's
 * workspace and everything under it, then the installation. GitHub has already removed the
 * runners, so there's no label to take off.
 */
export async function forgetInstallation(env: Env, db: Db, installationId: number) {
  const [workspace] = await db
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(eq(schema.workspace.installationId, installationId))
    .limit(1);
  if (workspace) {
    const machines = await db
      .select({ id: schema.machine.id })
      .from(schema.machine)
      .where(eq(schema.machine.workspaceId, workspace.id));
    await forgetWorkspaces(env, db, [workspace.id], machines);
  }
  await db
    .delete(schema.githubInstallation)
    .where(eq(schema.githubInstallation.id, installationId));
}

// Closes machine sockets and wipes the Durable Objects nothing will call again, clears sessions'
// active-workspace pointers (no foreign key there), then deletes the workspaces' installations.
// D1's foreign keys take the workspaces and everything under them.
async function forgetWorkspaces(
  env: Env,
  db: Db,
  workspaceIds: string[],
  machines: { id: string }[],
) {
  await Promise.all([
    ...machines.map((machine) => env.MACHINE_LINK.getByName(machine.id).purge()),
    ...workspaceIds.map((id) => env.ROUTER.getByName(id).purge()),
  ]);
  await db
    .update(schema.session)
    .set({ activeWorkspaceId: null })
    .where(inArray(schema.session.activeWorkspaceId, workspaceIds));
  const installations = db
    .select({ id: schema.workspace.installationId })
    .from(schema.workspace)
    .where(inArray(schema.workspace.id, workspaceIds));
  await db
    .delete(schema.githubInstallation)
    .where(inArray(schema.githubInstallation.id, installations));
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
