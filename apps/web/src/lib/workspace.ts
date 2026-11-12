import { api } from "@/lib/api";

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
  workspace: {
    id: string;
    name: string;
    slug: string;
    /** The GitHub account's avatar (#316). */
    logo: string | null;
    createdAt: string;
  };
  role: string;
  installations: Installation[];
};

export function getCurrentWorkspace() {
  return api<CurrentWorkspace>("/workspaces/current");
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
