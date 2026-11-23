// Which of a workspace's repos the org's Default runner group leaves out, for the Router page's
// "Route a repo" sheet. GitHub only offers a repo's relay job to RelayRunner's pick runner when the
// group lets the repo use it (src/routing/pick-access.ts), so a routed repo outside it never runs. The
// sheet says so before the PR is opened, rather than after the first run sits queued.
//
// Cost: one or two GitHub calls (the group, and its repo list when it's "selected") and one
// github_repository read by installation.
import { and, eq, isNull } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import { appInstallationToken } from "./github-app.ts";
import { DEFAULT_RUNNER_GROUP_ID } from "./runners-api.ts";
import { fetchOneGroupAccess, groupBlocksRepo } from "./github-runners.ts";

type Block = NonNullable<ReturnType<typeof groupBlocksRepo>>;

export interface RunnerGroupCheck {
  groupName: string;
  /** The group's page on GitHub, where an org owner changes Repository access. */
  settingsUrl: string;
  /** Each repo the group leaves out, and why. */
  blocked: { repositoryId: number; block: Block }[];
}

/** Null for a personal account, which has no runner groups. */
export async function runnerGroupCheck(
  env: Parameters<typeof appInstallationToken>[0],
  db: Db,
  installation: { id: number; login: string; type: string },
): Promise<RunnerGroupCheck | null> {
  if (installation.type !== "Organization") return null;
  const repo = schema.githubRepository;
  const [access, repos] = await Promise.all([
    appInstallationToken(env, installation.id).then((token) =>
      fetchOneGroupAccess(token, installation.login, DEFAULT_RUNNER_GROUP_ID),
    ),
    db
      .select({ id: repo.id, private: repo.private })
      .from(repo)
      .where(and(eq(repo.installationId, installation.id), isNull(repo.removedAt))),
  ]);
  return {
    groupName: access.groupName,
    settingsUrl: `https://github.com/organizations/${encodeURIComponent(installation.login)}/settings/actions/runner-groups/${DEFAULT_RUNNER_GROUP_ID}`,
    blocked: repos.flatMap((row) => {
      const block = groupBlocksRepo(access, row);
      return block ? [{ repositoryId: row.id, block }] : [];
    }),
  };
}
