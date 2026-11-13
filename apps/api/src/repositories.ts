import type { InstallationRepo } from "@relayrunner/github-webhooks";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { findInstallation } from "./installations.ts";

// Keeps github_repository in step with the repos each installation can see. Webhooks are the only
// writers: `installation` created brings the starting list, `installation_repositories` adds and
// removes, and `repository` events cover renames, visibility changes, transfers, deletes, and new
// repos in "All repositories" installs. The queue is unordered and retries, so every write is
// stamped with the event's receivedAt and never overwrites a row stamped later.

// D1 allows 100 bound parameters per statement. Each row binds 8, plus a few for the update.
const CHUNK = 10;

// Records repos the installation can see.
export function upsertRepositories(
  db: Db,
  installationId: number,
  repos: InstallationRepo[],
  observedAt: Date,
) {
  return writeRepositories(db, installationId, repos, observedAt, null);
}

// Marks repos the installation can no longer see. A tombstone row, not a delete (and written even
// for a repo we never stored), so a retried older "added" can't bring it back.
export function removeRepositories(
  db: Db,
  installationId: number,
  repos: InstallationRepo[],
  observedAt: Date,
) {
  return writeRepositories(db, installationId, repos, observedAt, observedAt);
}

// Skipped when the installation has no row (its event hasn't arrived yet, or it was uninstalled):
// `created` carries the full list, so nothing is lost.
async function writeRepositories(
  db: Db,
  installationId: number,
  repos: InstallationRepo[],
  observedAt: Date,
  removedAt: Date | null,
) {
  if (!repos.length || !(await findInstallation(db, installationId))) return;
  const table = schema.githubRepository;
  for (let i = 0; i < repos.length; i += CHUNK) {
    const rows = repos.slice(i, i + CHUNK).map((repo) => ({
      id: repo.id,
      installationId,
      fullName: repo.fullName,
      private: repo.private,
      removedAt,
      githubStateAt: observedAt,
    }));
    await db
      .insert(table)
      .values(rows)
      .onConflictDoUpdate({
        target: table.id,
        set: {
          installationId: sql`excluded.installation_id`,
          fullName: sql`excluded.full_name`,
          private: sql`excluded.private`,
          removedAt: sql`excluded.removed_at`,
          githubStateAt: sql`excluded.github_state_at`,
          updatedAt: sql`excluded.updated_at`,
        },
        // A tombstone from another installation (the repo was transferred out) never hides the
        // repo from the installation that now has it.
        setWhere: and(
          lte(table.githubStateAt, observedAt),
          removedAt ? eq(table.installationId, installationId) : undefined,
        ),
      });
  }
}

// A `repository` event. `deleted` removes the repo, and so does `transferred` to an account other
// than the installation's. Every other action (created, renamed, privatized, publicized,
// archived, edited, ...) carries the repo's current name and visibility.
export async function recordRepositoryEvent(
  db: Db,
  installationId: number,
  action: string | null,
  repo: InstallationRepo,
  observedAt: Date,
) {
  if (action === "deleted") return removeRepositories(db, installationId, [repo], observedAt);
  if (action === "transferred") {
    const installation = await findInstallation(db, installationId);
    const owner = repo.fullName.split("/")[0]?.toLowerCase();
    if (installation && owner !== installation.accountLogin.toLowerCase())
      return removeRepositories(db, installationId, [repo], observedAt);
  }
  await upsertRepositories(db, installationId, [repo], observedAt);
}

/** A repo the installation can still see, by owner/name in any case, or undefined. */
export async function findRepo(db: Db, installationId: number, fullName: string) {
  const [repo] = await db
    .select({ id: schema.githubRepository.id, private: schema.githubRepository.private })
    .from(schema.githubRepository)
    .where(
      and(
        eq(schema.githubRepository.installationId, installationId),
        sql`lower(${schema.githubRepository.fullName}) = ${fullName.toLowerCase()}`,
        isNull(schema.githubRepository.removedAt),
      ),
    )
    .limit(1);
  return repo;
}
