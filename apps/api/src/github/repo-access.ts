// Whether a person can push to a repo on GitHub. Settings that belong to one repo's jobs, such as
// an auto job's size, follow it: anyone who could edit the repo's workflow files can change them,
// as well as the workspace's owners and admins.
import { AppError } from "@relayrunner/errors";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../app.ts";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { appInstallationToken } from "./github-app.ts";
import { userCanWriteRepo } from "./repos-api.ts";
import { userGitHubId } from "./memberships.ts";
import { Recent } from "../recent.ts";
import { canManage } from "../auth/roles.ts";

// Long enough that the Router page and a run of agent changes ask GitHub once, short enough that
// losing access on GitHub soon stops working here.
const WRITE_ACCESS_MS = 5 * 60_000;
const writers = new Recent<string, boolean>(500);

/**
 * Whether the user can push to the repo, by GitHub repository id, as the installation that has it
 * sees it. No GitHub sign-in, or a repo no installation has any more, is no. Throws when GitHub
 * can't be asked; nothing is cached then.
 */
export function userCanEditRepo(env: Env, db: Db, userId: string, repositoryId: number) {
  return writers.get(`${repositoryId}:${userId}`, WRITE_ACCESS_MS, async () => {
    const [githubId, [repo]] = await Promise.all([
      userGitHubId(db, userId),
      db
        .select({
          installationId: schema.githubRepository.installationId,
          fullName: schema.githubRepository.fullName,
        })
        .from(schema.githubRepository)
        .where(
          and(
            eq(schema.githubRepository.id, repositoryId),
            isNull(schema.githubRepository.removedAt),
          ),
        )
        .limit(1),
    ]);
    if (githubId === null || !repo) return false;
    const token = await appInstallationToken(env, repo.installationId);
    return userCanWriteRepo(token, repo.fullName, githubId);
  });
}

/** For the Router page: which of these repos the user can push to. One that GitHub can't answer for is no. */
export async function editableRepos(env: Env, db: Db, userId: string, repositoryIds: number[]) {
  const ids = [...new Set(repositoryIds)];
  const allowed = await Promise.all(
    ids.map((id) => userCanEditRepo(env, db, userId, id).catch(() => false)),
  );
  return new Set(ids.filter((_, i) => allowed[i]));
}

/**
 * Lets owners and admins through, and anyone who can push to the repo; anyone else gets
 * FORBIDDEN, naming what (`its jobs`, `its runner order`) they can't change.
 */
export async function assertCanEditRepo(
  c: Context<AppEnv>,
  repo: { id: number; fullName: string },
  what: string,
) {
  const { db, role, user } = c.var;
  if (canManage(role) || (await userCanEditRepo(c.env, db, user!.id, repo.id))) return;
  throw new AppError("FORBIDDEN", {
    message: `Only owners, admins and people who can push to ${repo.fullName} can change ${what}.`,
  });
}
