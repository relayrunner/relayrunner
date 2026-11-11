import { and, eq, inArray } from "drizzle-orm";
import { recordEvent } from "./activity.ts";
import type { Auth } from "./auth.ts";
import { type Db, schema } from "./db/index.ts";
import { GitHubError, type GitHubInstallation, listUserInstallations } from "./github.ts";
import {
  ensureWorkspace,
  upsertInstallation,
  userGitHubToken,
  workspaceIdForInstallation,
} from "./installations.ts";

// Workspace membership comes from GitHub (#317): you're a member of every workspace whose
// installation your GitHub sign-in can see in GET /user/installations. That list is synced into
// workspace_member on sign-in, when the dashboard lists workspaces (at most every SYNC_INTERVAL_MS),
// and by the Setup URL after an install. Membership is for the dashboard only: routing never
// trusts it for repo access, and checks with GitHub itself.
//
// The installer is the owner: the `installation.created` webhook's sender
// (github_installation.installer_github_id), or the account's own user for a personal install.
// Everyone else joins as a member, and owners promote people in the dashboard. A role, once set,
// is left alone by later syncs.

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

export interface SyncResult {
  /** Workspaces the user was added to. */
  joined: string[];
  /** Workspaces the user was taken out of, because GitHub no longer shows them the install. */
  removed: string[];
}

/**
 * Reads the user's installations from GitHub and syncs their memberships. Skipped (null) when they
 * synced within SYNC_INTERVAL_MS, unless `force`. Also null when GitHub can't be read (no token,
 * an expired one, or GitHub down): then nothing changes, so an outage never removes anyone.
 */
export async function syncMembershipsFromGitHub(
  auth: Auth,
  db: Db,
  userId: string,
  { force = false }: { force?: boolean } = {},
): Promise<SyncResult | null> {
  if (!force) {
    const [row] = await db
      .select({ syncedAt: schema.user.installationsSyncedAt })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);
    if (row?.syncedAt && Date.now() - row.syncedAt.getTime() < SYNC_INTERVAL_MS) return null;
  }
  const token = await userGitHubToken(auth, db, userId);
  if (!token) return null;
  let installations: GitHubInstallation[];
  try {
    installations = await listUserInstallations(token);
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: "membership sync skipped: GitHub installations unreadable",
        userId,
        status: error instanceof GitHubError ? error.status : null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
  return syncMemberships(db, userId, installations);
}

/**
 * Makes the user's memberships match `installations`, the list GitHub just gave for their token.
 * An installation we never recorded (a missed webhook) gets its workspace made here, since the
 * user's own token vouches for it.
 */
export async function syncMemberships(
  db: Db,
  userId: string,
  installations: GitHubInstallation[],
): Promise<SyncResult> {
  const wanted = new Map<string, number>();
  for (const installation of installations) {
    let workspaceId: string | null = await workspaceIdForInstallation(db, installation.id);
    if (!workspaceId) {
      await upsertInstallation(db, installation);
      workspaceId = await ensureWorkspace(db, installation.id);
    }
    if (workspaceId) wanted.set(workspaceId, installation.id);
  }

  const current = await db
    .select({ id: schema.workspaceMember.id, workspaceId: schema.workspaceMember.workspaceId })
    .from(schema.workspaceMember)
    .where(eq(schema.workspaceMember.userId, userId));
  const have = new Set(current.map((row) => row.workspaceId));

  const [user] = await db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  const githubId = await userGitHubId(db, userId);
  const owned = await installationsOwnedBy(db, githubId, [...wanted.values()]);

  const joined: string[] = [];
  for (const [workspaceId, installationId] of wanted) {
    if (have.has(workspaceId)) continue;
    const role = owned.has(installationId) ? "owner" : "member";
    const inserted = await db
      .insert(schema.workspaceMember)
      .values({ id: crypto.randomUUID(), workspaceId, userId, role })
      .onConflictDoNothing()
      .returning({ id: schema.workspaceMember.id });
    if (inserted.length === 0) continue;
    joined.push(workspaceId);
    await recordEvent(db, {
      workspaceId,
      actorUserId: userId,
      type: "member.joined",
      data: { name: user?.name ?? "", email: user?.email ?? "", role },
    });
  }

  const removed: string[] = [];
  for (const row of current) {
    if (wanted.has(row.workspaceId)) continue;
    await db.delete(schema.workspaceMember).where(eq(schema.workspaceMember.id, row.id));
    removed.push(row.workspaceId);
    // Reads as "<name> left the workspace": they lost access to the install on GitHub.
    await recordEvent(db, {
      workspaceId: row.workspaceId,
      actorUserId: userId,
      type: "member.removed",
      data: { memberName: user?.name ?? "A member", left: true },
    });
  }

  await db
    .update(schema.user)
    .set({ installationsSyncedAt: new Date() })
    .where(eq(schema.user.id, userId));
  return { joined, removed };
}

/**
 * Records who installed the App (the `installation.created` webhook's sender) and, if they've
 * signed in to RelayRunner before, makes them the workspace's owner now rather than at their next
 * sync.
 */
export async function recordInstaller(db: Db, installationId: number, githubId: number) {
  await db
    .update(schema.githubInstallation)
    .set({ installerGithubId: githubId })
    .where(eq(schema.githubInstallation.id, installationId));
  const [account] = await db
    .select({ userId: schema.account.userId })
    .from(schema.account)
    .where(
      and(eq(schema.account.providerId, "github"), eq(schema.account.accountId, String(githubId))),
    )
    .limit(1);
  const workspaceId = await workspaceIdForInstallation(db, installationId);
  if (!account || !workspaceId) return;
  await db
    .insert(schema.workspaceMember)
    .values({ id: crypto.randomUUID(), workspaceId, userId: account.userId, role: "owner" })
    .onConflictDoUpdate({
      target: [schema.workspaceMember.workspaceId, schema.workspaceMember.userId],
      set: { role: "owner" },
    });
}

/** The user's numeric GitHub id, from their GitHub sign-in. Null without one. */
async function userGitHubId(db: Db, userId: string) {
  const [row] = await db
    .select({ accountId: schema.account.accountId })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
    .limit(1);
  const id = Number(row?.accountId);
  return Number.isSafeInteger(id) ? id : null;
}

/** Of `installationIds`, the ones `githubId` installed, or whose personal account they are. */
async function installationsOwnedBy(db: Db, githubId: number | null, installationIds: number[]) {
  if (githubId === null || installationIds.length === 0) return new Set<number>();
  const rows = await db
    .select({
      id: schema.githubInstallation.id,
      accountId: schema.githubInstallation.accountId,
      accountType: schema.githubInstallation.accountType,
      installerGithubId: schema.githubInstallation.installerGithubId,
    })
    .from(schema.githubInstallation)
    .where(inArray(schema.githubInstallation.id, installationIds));
  return new Set(
    rows
      .filter(
        (row) =>
          row.installerGithubId === githubId ||
          (row.accountType === "User" && row.accountId === githubId),
      )
      .map((row) => row.id),
  );
}
