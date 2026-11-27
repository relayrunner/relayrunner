import { providersOfAppSlugs, type HostedProviderId } from "@relayrunner/providers";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { appInstallationToken, orgAppSlugs } from "../github/github-app.ts";
import { log } from "../log.ts";

export interface ProviderApps {
  /** The hosted providers whose GitHub App is installed, or null when that can't be told. */
  installed: HostedProviderId[] | null;
  /** The GitHub account the workspace is installed on, or null without one. */
  account: { login: string; type: string } | null;
}

/**
 * Which hosted providers' GitHub Apps the workspace's GitHub account has installed. GitHub lists
 * only an organization's apps, so a personal account, or a read that failed, answers null.
 */
export async function workspaceProviderApps(
  env: Env,
  db: Db,
  workspaceId: string,
): Promise<ProviderApps> {
  const [row] = await db
    .select({
      installationId: schema.githubInstallation.id,
      login: schema.githubInstallation.accountLogin,
      type: schema.githubInstallation.accountType,
    })
    .from(schema.workspace)
    .innerJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .where(eq(schema.workspace.id, workspaceId))
    .limit(1);
  if (!row) return { installed: null, account: null };
  const account = { login: row.login, type: row.type };
  if (row.type !== "Organization") return { installed: null, account };
  try {
    const token = await appInstallationToken(env, row.installationId);
    return { installed: providersOfAppSlugs(await orgAppSlugs(token, row.login)), account };
  } catch (error) {
    log.error("github.apps_unavailable", "provider apps read failed", {
      installationId: row.installationId,
      error,
    });
    return { installed: null, account };
  }
}
