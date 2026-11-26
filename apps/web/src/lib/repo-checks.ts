import { api } from "./api.ts";

// The pull request checks each repo turns on in its relayrunner.yml (apps/api/src/checks/repo-checks.ts).
export interface RepoChecks {
  repository: string;
  path: string;
  // Why the file couldn't be read. When set, every check is off.
  error: string | null;
  prTitle: { types: string[] } | null;
  prDescription: { minLength: number } | null;
  lint: { tools: string[]; paths: string[] } | null;
}

export interface RepoChecksView {
  repositories: RepoChecks[];
  checked: number;
  total: number;
  lintAvailable: boolean;
}

/** GET /api/workspaces/:id/repo-checks: only repos that have a relayrunner.yml, by name. */
export function getRepoChecks(workspaceId: string) {
  return api<RepoChecksView>(`/workspaces/${encodeURIComponent(workspaceId)}/repo-checks`);
}

/** Each check a repo turns on, in words, such as "PR description (50+ characters)". */
export function checkLabels(repo: RepoChecks): string[] {
  const labels: string[] = [];
  if (repo.prTitle)
    labels.push(
      repo.prTitle.types.length ? `PR title (${repo.prTitle.types.join(", ")})` : "PR title",
    );
  if (repo.prDescription)
    labels.push(
      repo.prDescription.minLength > 1
        ? `PR description (${repo.prDescription.minLength}+ characters)`
        : "PR description",
    );
  if (repo.lint) labels.push(`Lint (${repo.lint.tools.join(", ")})`);
  return labels;
}
