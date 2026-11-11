// What GET /api/github/setup reports back in ?github=, in plain language.
export const githubOutcomes = {
  connected: { tone: "go", message: "GitHub account connected." },
  updated: { tone: "go", message: "Your changes on GitHub are saved." },
  unclaimed: {
    tone: "run",
    message:
      "The GitHub App is installed but isn't in a workspace yet. Add it under Unclaimed installations.",
  },
  requested: {
    tone: "run",
    message:
      "Install request sent to the org's owners. Once one approves it, add the org under Unclaimed installations.",
  },
  taken: {
    tone: "run",
    message:
      "That GitHub account is already connected to another workspace. An account can only belong to one workspace.",
  },
  not_found: {
    tone: "run",
    message:
      "Your GitHub account can't see that installation, so nothing was connected. Ask an org owner to connect it.",
  },
  expired: {
    tone: "run",
    message:
      "That connect link expired, so nothing was connected. If the GitHub App is installed, add it under Unclaimed installations.",
  },
  reauth: {
    tone: "run",
    message:
      "Your GitHub sign-in has expired, so nothing was connected. Sign in again, then add the account under Unclaimed installations.",
  },
  invalid: {
    tone: "run",
    message: "GitHub didn't say which installation to connect. Try connecting again.",
  },
} as const;

export type GitHubOutcome = keyof typeof githubOutcomes;

export function isGitHubOutcome(value: unknown): value is GitHubOutcome {
  return typeof value === "string" && Object.hasOwn(githubOutcomes, value);
}

/** Where to send the browser to install the GitHub App, coming back to `next` afterwards. */
export function githubInstallHref(next?: string) {
  return next ? `/api/github/install?next=${encodeURIComponent(next)}` : "/api/github/install";
}
