import type { RepoChecksView } from "../repo-checks.ts";

/** Example repo checks for the dev preview's Settings › GitHub page. */
export function sampleRepoChecks(): RepoChecksView {
  const none = { error: null, prTitle: null, prDescription: null, lint: null };
  return {
    repositories: [
      {
        ...none,
        repository: "acme/api",
        path: ".github/relayrunner.yml",
        prTitle: { types: [] },
        prDescription: { minLength: 50 },
        lint: { tools: ["oxlint", "typos"], paths: [] },
      },
      { ...none, repository: "acme/docs", path: "relayrunner.yml", prTitle: { types: ["docs"] } },
      {
        ...none,
        repository: "acme/web",
        path: ".github/relayrunner.yml",
        error: 'checks: Unrecognized key: "pr-titel"',
      },
    ],
    checked: 12,
    total: 12,
    lintAvailable: false,
  };
}
