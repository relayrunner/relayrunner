// What GET /api/github/setup reports back in ?github=, in plain language.
export const githubOutcomes = {
  connected: { tone: "go", message: "GitHub account connected." },
  updated: { tone: "go", message: "Your changes on GitHub are saved." },
  requested: {
    tone: "run",
    message:
      "Install request sent to the org's owners. Once one approves it, the org gets its own workspace.",
  },
  not_found: {
    tone: "run",
    message:
      "Your GitHub account can't see that installation, so nothing was connected. Ask an org owner to give you access on GitHub.",
  },
  reauth: {
    tone: "run",
    message:
      "Your GitHub sign-in has expired, so nothing was connected. Sign in again, then install again.",
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
