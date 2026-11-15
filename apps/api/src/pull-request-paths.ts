/**
 * The parts of a repo each pull request changes, for the Signals page: which areas (top folders)
 * use the most CI minutes, and whether a pull request that only changed docs still ran CI.
 *
 * Before each hourly signals rollup (src/installation-tasks.ts), the installation reads the files
 * of its pull requests that ran lately and that have no row yet, or whose newest run is for a
 * commit other than the one read. Newest first, at most MAX_READS a run, so a first run over 30
 * days of pull requests catches up over a few hours instead of spending the installation's rate
 * limit at once. Only names are kept, folded into areas: never a file's contents.
 */
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  appInstallationToken,
  GitHubAccessError,
  GitHubRateLimitError,
  pullRequestFiles,
} from "./github-app.ts";
import { DAY_MS } from "./job-timings.ts";
import { liveDays } from "./signals.ts";
import { errorMessage } from "./webhook-queue.ts";

const run = schema.workflowRun;
const paths = schema.pullRequestPaths;

// Pull requests read per installation and run, and at once.
const MAX_READS = 60;
const PARALLEL_READS = 4;
// Areas kept per pull request.
const MAX_AREAS = 50;

// The area of files at the root of the repo.
const ROOT_AREA = "/";

// Folders that hold one project per subfolder, so apps/web is an area and not all of apps.
const CONTAINERS = new Set([
  "apps",
  "packages",
  "services",
  "libs",
  "lib",
  "crates",
  "modules",
  "projects",
  "plugins",
  "cmd",
  "internal",
]);

/** The area a file belongs to: its top folder, or two levels down inside a folder of projects. */
export function areaOf(file: string) {
  const parts = file.split("/");
  if (parts.length === 1) return ROOT_AREA;
  const depth = CONTAINERS.has(parts[0]!) && parts.length > 2 ? 2 : 1;
  return parts.slice(0, depth).join("/");
}

const DOCS_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const DOCS_FOLDER = /(^|\/)docs?\//i;
const LICENSE = /(^|\/)(license|licence|copying)(\.[a-z]+)?$/i;

/** Whether a file is documentation: prose files, anything under a docs folder, or a license. */
export function isDocs(file: string) {
  return DOCS_FILE.test(file) || DOCS_FOLDER.test(file) || LICENSE.test(file);
}

/**
 * What a pull request's files say about it. Null names (too many to list, or a pull request that
 * is gone) give no areas.
 */
export function summarize(names: string[] | null) {
  if (names === null) return { areas: [], docsOnly: false };
  return {
    areas: [...new Set(names.map(areaOf))].sort().slice(0, MAX_AREAS),
    docsOnly: names.length > 0 && names.every(isDocs),
  };
}

/**
 * Reads the files of the installation's recently run pull requests that have none stored, or
 * whose newest run is for another commit. Stops at the first refusal or rate limit: the next
 * hour tries again. Returns how many were read.
 */
export async function syncPullRequestPaths(
  env: Env,
  db: Db,
  installationId: number,
  now = Date.now(),
) {
  // The days the rollup counts single jobs over.
  const since = new Date(now - liveDays() * DAY_MS);
  // Each pull request's newest run: SQLite takes the bare columns from the max() row.
  const newest = db
    .select({
      repositoryId: run.repositoryId,
      repository: run.repositoryFullName,
      pullRequestNumber: run.pullRequestNumber,
      headSha: run.headSha,
      at: sql<number>`max(${run.githubUpdatedAt})`.as("at"),
    })
    .from(run)
    .where(
      and(
        eq(run.installationId, installationId),
        gte(run.githubUpdatedAt, since),
        isNotNull(run.pullRequestNumber),
      ),
    )
    .groupBy(run.repositoryId, run.pullRequestNumber)
    .as("newest");
  const due = await db
    .select({
      repositoryId: newest.repositoryId,
      repository: newest.repository,
      pullRequestNumber: newest.pullRequestNumber,
      headSha: newest.headSha,
    })
    .from(newest)
    .leftJoin(
      paths,
      and(
        eq(paths.repositoryId, newest.repositoryId),
        eq(paths.pullRequestNumber, newest.pullRequestNumber),
      ),
    )
    .where(sql`${paths.headSha} is null or ${paths.headSha} != ${newest.headSha}`)
    .orderBy(desc(newest.at))
    .limit(MAX_READS);
  if (!due.length) return 0;

  const token = await appInstallationToken(env, installationId);
  const rows: (typeof paths.$inferInsert)[] = [];
  let stopped = false;
  async function worker() {
    for (let next = due.shift(); next && !stopped; next = due.shift()) {
      const pullRequestNumber = next.pullRequestNumber!;
      let names: string[] | null;
      try {
        const files = await pullRequestFiles(token, next.repository, pullRequestNumber, {
          cache: false,
        });
        names = files && files.map((file) => file.filename);
      } catch (error) {
        // A missing pull request (deleted, or the repo left the installation) is stored without
        // areas, so it waits for a new commit; a refusal or rate limit stops the run.
        if (!(error instanceof GitHubAccessError || error instanceof GitHubRateLimitError))
          throw error;
        if (!(error instanceof GitHubAccessError && error.status === 404)) {
          stopped = true;
          console.warn(
            JSON.stringify({
              msg: "pull request files stopped",
              installationId,
              error: errorMessage(error),
            }),
          );
          return;
        }
        names = null;
      }
      rows.push({
        installationId,
        repositoryId: next.repositoryId,
        pullRequestNumber,
        headSha: next.headSha,
        ...summarize(names),
        readAt: new Date(now),
      });
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_READS }, worker));
  // Written together once the reads are done: what was read before a stop still goes in.
  const [first, ...rest] = rows.map((row) =>
    db
      .insert(paths)
      .values(row)
      .onConflictDoUpdate({ target: [paths.repositoryId, paths.pullRequestNumber], set: row }),
  );
  if (first) await db.batch([first, ...rest]);
  return rows.length;
}
