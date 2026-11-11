import { and, count, eq, isNull, lte, or } from "drizzle-orm";
import type { Auth } from "./auth.ts";
import { type Db, schema } from "./db/index.ts";
import type { GitHubInstallation } from "./github.ts";
import { runnerScope } from "./github-app.ts";

// Records what GitHub says about an installation: the account it's on, which repos it sees, and
// whether it's suspended. Never touches workspace_id, so a webhook arriving before or after the
// Setup URL callback can't undo a link. `observedAt` orders updates: a retried `suspend` that
// lands after a newer `unsuspend` is dropped.
export async function upsertInstallation(
  db: Db,
  installation: GitHubInstallation,
  observedAt = new Date(),
) {
  if (!installation.account) return;
  const fields = {
    accountId: installation.account.id,
    accountLogin: installation.account.login,
    accountType: installation.account.type,
    repositorySelection: installation.repository_selection ?? "all",
    suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    githubStateAt: observedAt,
  };
  await db
    .insert(schema.githubInstallation)
    .values({ id: installation.id, ...fields })
    .onConflictDoUpdate({
      target: schema.githubInstallation.id,
      set: { ...fields, updatedAt: new Date() },
      setWhere: or(
        isNull(schema.githubInstallation.githubStateAt),
        lte(schema.githubInstallation.githubStateAt, observedAt),
      ),
    });
}

export type LinkResult = "linked" | "taken";

// Links an unclaimed installation to a workspace in one statement, so two workspaces racing for
// the same installation can't both win. Linking one that is already in this workspace is a no-op.
export async function linkInstallation(
  db: Db,
  installationId: number,
  workspaceId: string,
): Promise<LinkResult> {
  const rows = await db
    .update(schema.githubInstallation)
    .set({ workspaceId, updatedAt: new Date() })
    .where(
      and(
        eq(schema.githubInstallation.id, installationId),
        or(
          isNull(schema.githubInstallation.workspaceId),
          eq(schema.githubInstallation.workspaceId, workspaceId),
        ),
      ),
    )
    .returning({ id: schema.githubInstallation.id });
  return rows.length ? "linked" : "taken";
}

export async function findInstallation(db: Db, installationId: number) {
  const [row] = await db
    .select()
    .from(schema.githubInstallation)
    .where(eq(schema.githubInstallation.id, installationId))
    .limit(1);
  return row ?? null;
}

// The user's GitHub user-to-server token from their sign-in, refreshed by Better Auth if the
// GitHub App issues expiring tokens. Null when there's no GitHub account or the refresh fails, in
// which case the user needs to sign in again.
export async function userGitHubToken(auth: Auth, db: Db, userId: string) {
  const [account] = await db
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
    .limit(1);
  if (!account) return null;
  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: { accountId: account.id, userId },
    });
    return accessToken ?? null;
  } catch {
    return null;
  }
}

export async function isWorkspaceMember(db: Db, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ role: schema.workspaceMember.role })
    .from(schema.workspaceMember)
    .where(
      and(
        eq(schema.workspaceMember.workspaceId, workspaceId),
        eq(schema.workspaceMember.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** How many people are in a workspace, for the CLI to know whether sharing is worth asking about. */
export async function workspaceMemberCount(db: Db, workspaceId: string) {
  const [row] = await db
    .select({ members: count() })
    .from(schema.workspaceMember)
    .where(eq(schema.workspaceMember.workspaceId, workspaceId));
  return row?.members ?? 0;
}

/**
 * Where an installation's one-job runner for `repo` registers (see runnerScope). An installation
 * RelayRunner hasn't recorded is treated as an org, as every installation was before personal
 * accounts.
 */
export async function installationRunnerScope(db: Db, installationId: number, repo: string) {
  const [row] = await db
    .select({ accountType: schema.githubInstallation.accountType })
    .from(schema.githubInstallation)
    .where(eq(schema.githubInstallation.id, installationId))
    .limit(1);
  return runnerScope(row?.accountType, repo);
}
