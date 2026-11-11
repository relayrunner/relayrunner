import { ApiError, api } from "@/lib/api";
import { authClient, organization, type Session } from "@/lib/auth-client";
import { firstWorkspaceName } from "@/lib/onboarding";

/** A GitHub App installation: the org or personal account it's on and what it can see. */
export type Installation = {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
  /** The installation's settings page on GitHub. */
  settingsUrl: string;
};

/** GET /api/workspaces/current: the active workspace as the gateway sees it. */
export type CurrentWorkspace = {
  workspace: { id: string; name: string; slug: string; createdAt: string };
  role: string;
  installations: Installation[];
};

export function getCurrentWorkspace() {
  return api<CurrentWorkspace>("/workspaces/current");
}

/** The gateway's error when the user's GitHub token is gone or revoked. */
export function needsGitHubSignIn(error: unknown) {
  return error instanceof ApiError && error.code === "github_reauth";
}

export type UnclaimedInstallations = {
  installations: Installation[];
  problem?: "reauth" | "unavailable";
};

/**
 * Installations the user can see on GitHub that no workspace holds yet. Never
 * throws: a GitHub hiccup shouldn't take the workspace page down with it.
 */
export async function getUnclaimedInstallations(): Promise<UnclaimedInstallations> {
  try {
    return await api<{ installations: Installation[] }>("/github/installations/unclaimed");
  } catch (error) {
    return { installations: [], problem: needsGitHubSignIn(error) ? "reauth" : "unavailable" };
  }
}

/** One GitHub API rate limit bucket. `reset` is when the hourly window starts over. */
export type RateLimitBucket = { limit: number; used: number; remaining: number; reset: string };

/** GET /api/github/installations/:id/rate-limit: the installation's quota, read live from GitHub. */
export type RateLimits = {
  core: RateLimitBucket | null;
  graphql: RateLimitBucket | null;
  actionsRunnerRegistration: RateLimitBucket | null;
};

export function getRateLimits(installationId: number) {
  return api<RateLimits>(`/github/installations/${installationId}/rate-limit`);
}

/** Links an unclaimed installation to the active workspace. */
export function claimInstallation(id: number) {
  return api<{ ok: true }>(`/github/installations/${id}/claim`, { method: "POST" });
}

/**
 * Makes sure the session has an active workspace, picking the user's first one
 * if none is set. Returns null when the user has no workspace yet.
 */
export async function ensureActiveWorkspace(session: Session): Promise<string | null> {
  if (session.session.activeOrganizationId) return session.session.activeOrganizationId;
  const { data: workspaces } = await organization.list();
  const first = workspaces?.[0];
  if (!first) return null;
  await organization.setActive({ organizationId: first.id });
  return first.id;
}

/** "Acme Labs!" -> "acme-labs" */
export function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Creates a workspace owned by the signed-in user and makes it active. The
 * slug comes from the name, with a short suffix if it is taken.
 */
export async function createWorkspace(name: string) {
  const base = slugify(name) || "workspace";
  for (const slug of [base, `${base}-${randomSuffix()}`, `${base}-${randomSuffix()}`]) {
    const { data, error } = await organization.create({ name, slug });
    if (data) {
      // create updates the session row but not Better Auth's cached session
      // cookie; setActive refreshes the cookie too.
      await organization.setActive({ organizationId: data.id });
      return data;
    }
    if (error?.code !== "ORGANIZATION_ALREADY_EXISTS") {
      throw new Error(error?.message ?? "Could not create the workspace");
    }
  }
  throw new Error("Could not find a free URL for that name. Try another name.");
}

/**
 * Creates the first workspace for someone who has none, named after their GitHub login, and makes
 * it active (#221). They can rename it later in Settings.
 */
export async function createFirstWorkspace(session: Session) {
  return createWorkspace(firstWorkspaceName(await githubLogin(), session.user.name));
}

/**
 * The signed-in user's GitHub login. Better Auth keeps only the profile's display name, so this
 * asks GitHub through the account the user signed in with. Null if that fails.
 */
async function githubLogin(): Promise<string | null> {
  try {
    const { data: accounts } = await authClient.listAccounts();
    const github = accounts?.find((account) => account.providerId === "github");
    if (!github) return null;
    const { data } = await authClient.accountInfo({ query: { accountId: github.id } });
    const login = (data?.data as { login?: unknown } | undefined)?.login;
    return typeof login === "string" ? login : null;
  } catch {
    return null;
  }
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6);
}
