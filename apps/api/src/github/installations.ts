import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Auth } from "../auth/auth.ts";
import { type Db, schema } from "../db/index.ts";
import type { GitHubInstallation } from "./github.ts";
import { runnerScope } from "./runners-api.ts";
import { isExpired } from "./user-tokens.ts";

// Records what GitHub says about an installation: the account it's on, which repos it sees, and
// whether it's suspended. `observedAt` orders updates: a retried `suspend` that lands after a newer
// `unsuspend` is dropped. Callers follow with ensureWorkspace.
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

/** The avatar GitHub serves for an account, by its numeric id (stable across renames). */
export function accountAvatarUrl(accountId: number) {
  return `https://avatars.githubusercontent.com/u/${accountId}?v=4`;
}

/**
 * The installation's workspace (#316), made the first time we hear of the installation (the Setup
 * URL or the `installation.created` webhook, whichever lands first) and renamed after the account
 * on every later call. One upsert on installation_id, so the two racing can't make two. Returns
 * the workspace id, or null if the installation hasn't been recorded (upsertInstallation first).
 */
export async function ensureWorkspace(db: Db, installationId: number) {
  const installation = await findInstallation(db, installationId);
  // An enterprise install only reads its enterprise's billing (src/github/enterprise.ts): no workspace.
  if (!installation || installation.accountType === "Enterprise") return null;
  const fields = {
    name: installation.accountLogin,
    slug: installation.accountLogin.toLowerCase(),
    logo: accountAvatarUrl(installation.accountId),
  };
  const upsert = (slug: string) =>
    db
      .insert(schema.workspace)
      .values({ id: crypto.randomUUID(), installationId, ...fields, slug })
      .onConflictDoUpdate({
        target: schema.workspace.installationId,
        set: { ...fields, slug },
      })
      .returning({ id: schema.workspace.id });
  try {
    const [row] = await upsert(fields.slug);
    return row!.id;
  } catch (error) {
    // Another workspace still holds the login as its slug: an account renamed to a login another
    // install had, before that one's rename reached us. Installation ids never collide.
    if (!String(error).includes("workspace.slug")) throw error;
    const [row] = await upsert(`${fields.slug}-${installationId}`);
    return row!.id;
  }
}

/** The workspace of an installation, or null when there's none (an install we never recorded). */
export async function workspaceIdForInstallation(db: Db, installationId: number) {
  const [row] = await db
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(eq(schema.workspace.installationId, installationId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * An installation's row and its workspace's id, in one query, for code that needs both. A workspace
 * can't outlive its installation (workspace.installation_id cascades), so a missing installation
 * means no workspace either.
 */
export async function findInstallationAndWorkspace(
  db: Db,
  installationId: number,
): Promise<InstallationLookup> {
  const [row] = await db
    .select({ installation: schema.githubInstallation, workspaceId: schema.workspace.id })
    .from(schema.githubInstallation)
    .leftJoin(schema.workspace, eq(schema.workspace.installationId, schema.githubInstallation.id))
    .where(eq(schema.githubInstallation.id, installationId))
    .limit(1);
  return { installation: row?.installation ?? null, workspaceId: row?.workspaceId ?? null };
}

export type InstallationLookup = {
  installation: typeof schema.githubInstallation.$inferSelect | null;
  workspaceId: string | null;
};

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
    const { accessToken, accessTokenExpiresAt } = await auth.api.getAccessToken({
      body: { accountId: account.id, userId },
    });
    // Still expired means the renewal didn't happen (src/github/user-tokens.ts): GitHub would
    // only answer 401. A forgotten token comes back empty.
    if (!accessToken || isExpired(accessTokenExpiresAt)) return null;
    return accessToken;
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
