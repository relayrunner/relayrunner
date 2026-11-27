// Which pull request checks each of a workspace's repos turns on in its relayrunner.yml, for the
// dashboard's read-only view (Settings › GitHub). The file stays the only switch: this reads it
// from each repo's default branch, the same way the checks do.

import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "../db/index.ts";
import type { Env } from "../env.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { containerRunnerAllowed } from "../routing/container-runner.ts";
import { loadRepoConfig, type ConfigResult, type LintConfig } from "./repo-config.ts";

// Each repo costs up to two GitHub reads, so a big "All repositories" install reads only the
// first ones by name, a few at a time.
const MAX_REPOS = 100;
const BATCH = 10;
// One view per workspace is reused for this long per isolate, so reloading the page doesn't
// read every repo again.
const CACHE_MS = 60_000;

export interface RepoChecks {
  repository: string;
  // Where the file is, such as ".github/relayrunner.yml".
  path: string;
  // Why the file couldn't be read, or null. When set, the checks below are all off.
  error: string | null;
  prTitle: { types: string[] } | null;
  prDescription: { minLength: number } | null;
  lint: LintConfig | null;
}

export interface RepoChecksView {
  // Only repos that have a relayrunner.yml, by name.
  repositories: RepoChecks[];
  // How many repos were read, and how many the installation has.
  checked: number;
  total: number;
  // Whether lint runs for this account, which is in the lint preview or not.
  lintAvailable: boolean;
}

const cache = new Map<string, { view: RepoChecksView; until: number }>();

/** The checks each repo on the workspace's installation turns on. */
export async function repoChecks(
  env: Env,
  db: Db,
  workspaceId: string,
  installation: { id: number; login: string },
  now = Date.now(),
): Promise<RepoChecksView> {
  const cached = cache.get(workspaceId);
  if (cached && now < cached.until) return cached.view;

  const repo = schema.githubRepository;
  const rows = await db
    .select({ fullName: repo.fullName })
    .from(repo)
    .where(and(eq(repo.installationId, installation.id), isNull(repo.removedAt)))
    .orderBy(asc(repo.fullName));
  const names = rows.slice(0, MAX_REPOS).map((row) => row.fullName);
  const token = names.length ? await appInstallationToken(env, installation.id) : "";
  const configs: [string, ConfigResult][] = [];
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const loaded = await Promise.all(batch.map((name) => loadRepoConfig(token, name)));
    batch.forEach((name, index) => configs.push([name, loaded[index]]));
  }

  const view: RepoChecksView = {
    repositories: configs.flatMap(([repository, config]) => {
      const found = repoChecksOf(repository, config);
      return found ? [found] : [];
    }),
    checked: names.length,
    total: rows.length,
    lintAvailable: containerRunnerAllowed(env.CONTAINER_RUNNER_ORGS, installation.login),
  };
  cache.set(workspaceId, { view, until: now + CACHE_MS });
  return view;
}

/** One repo's row, or null when it has no relayrunner.yml. */
export function repoChecksOf(repository: string, config: ConfigResult): RepoChecks | null {
  if (config.kind === "none") return null;
  if (config.kind === "invalid")
    return {
      repository,
      path: config.path,
      error: config.error,
      prTitle: null,
      prDescription: null,
      lint: null,
    };
  const { path, prTitle, prDescription, lint } = config;
  return { repository, path, error: null, prTitle, prDescription, lint };
}
