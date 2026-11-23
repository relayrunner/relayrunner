// GitHub's actions/runner releases, so the dashboard can say when a machine's runner is behind.
// GitHub stops sending jobs to a runner about 30 days after a newer release comes out, and
// `relayrunner connect` installs the latest runner only when it starts, so a machine left connected
// for weeks falls behind. The hourly cron refreshes the list; reports read it through d1-cache.
import { isNewerVersion } from "@relayrunner/machine-protocol";
import { and, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { cachedRead } from "../d1-cache.ts";
import { type Db, schema } from "../db/index.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { userAgent } from "../routing/runner-protocol.ts";
import { DAY_MS } from "../time.ts";

export type RunnerRelease = { version: string; publishedAt: Date };

/** How long GitHub keeps sending jobs to a runner once a newer release is out. */
export const UPDATE_WINDOW_MS = 30 * DAY_MS;

const RELEASES_URL = "https://api.github.com/repos/actions/runner/releases?per_page=30";

const Releases = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
  }),
);

/**
 * A token to read the public releases with. Unauthenticated calls share GitHub's 60-an-hour limit
 * with everything else on Cloudflare's egress IPs, so they mostly fail with 403. Any active
 * installation's token can read a public repo, against that installation's own limit.
 */
export async function releasesToken(
  env: Parameters<typeof appInstallationToken>[0],
  db: Db,
): Promise<string | undefined> {
  const [installation] = await db
    .select({ id: schema.githubInstallation.id })
    .from(schema.githubInstallation)
    .where(
      and(
        isNull(schema.githubInstallation.suspendedAt),
        ne(schema.githubInstallation.accountType, "Enterprise"),
      ),
    )
    .orderBy(schema.githubInstallation.id)
    .limit(1);
  return installation ? appInstallationToken(env, installation.id) : undefined;
}

/** Fetches the recent releases from GitHub and saves any that are new. */
export async function syncRunnerReleases(db: Db, token?: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(RELEASES_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": userAgent,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok)
    throw new Error(`Could not list actions/runner releases. Status ${response.status}.`);
  const rows = Releases.parse(await response.json()).flatMap((release) => {
    const version = release.tag_name.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
    if (!version || release.draft || release.prerelease || !release.published_at) return [];
    return [{ version, publishedAt: new Date(release.published_at) }];
  });
  if (rows.length) await db.insert(schema.runnerRelease).values(rows).onConflictDoNothing();
  forgetRunnerReleases();
  return rows.length;
}

/**
 * The saved releases, cached per isolate; none when D1 can't be read, so nothing reads as behind.
 * forgetRunnerReleases drops the cache after new ones are saved.
 */
export const { load: loadRunnerReleases, forget: forgetRunnerReleases } = cachedRead(
  "runner releases",
  (db) => db.select().from(schema.runnerRelease),
  (): RunnerRelease[] => [],
);

/**
 * The newest release past `version`, and when GitHub may stop sending the runner jobs: 30 days
 * after the first release past it came out. Both null when it's up to date, or when no release is
 * known yet.
 */
export function runnerUpdate(version: string, releases: RunnerRelease[]) {
  let update: RunnerRelease | null = null;
  let first: RunnerRelease | null = null;
  for (const release of releases) {
    if (!isNewerVersion(release.version, version)) continue;
    if (!update || isNewerVersion(release.version, update.version)) update = release;
    if (!first || release.publishedAt < first.publishedAt) first = release;
  }
  return {
    update: update?.version ?? null,
    updateBy: first ? new Date(first.publishedAt.getTime() + UPDATE_WINDOW_MS) : null,
  };
}
