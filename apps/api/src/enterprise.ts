// The App installed on a GitHub enterprise account. An org inside an enterprise shares the
// enterprise's pooled Actions minutes, which GitHub only reports to the enterprise, so an org
// install alone can't judge a minutes limit. An enterprise owner can install the App on the
// enterprise too; that install gets only the App's enterprise permissions (read access to
// enterprise billing), no repos and no webhooks.
//
// An enterprise install is a github_installation row with account_type "Enterprise" and the
// enterprise's slug as its login. It never gets a workspace: the billing poll reads its usage
// (src/actions-billing.ts), learns which orgs belong to it from the report, and each of those
// orgs' workspaces is judged against the enterprise's minutes.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { GitHubInstallation } from "./github.ts";
import {
  type AppInstallation,
  getAppInstallation,
  listAppInstallations,
  mainAppJwt,
} from "./github-app.ts";
import { upsertInstallation } from "./installations.ts";

/** An App installation on an enterprise, in the shape upsertInstallation takes. Null otherwise. */
export function enterpriseInstallation(installation: AppInstallation): GitHubInstallation | null {
  const account = installation.account;
  const type = account?.type ?? installation.target_type;
  if (type !== "Enterprise" || !account?.slug) return null;
  return {
    id: installation.id,
    account: { id: account.id, login: account.slug, type: "Enterprise" },
    repository_selection: "selected",
    suspended_at: installation.suspended_at,
  };
}

/**
 * Records every enterprise install of the App. Enterprise installs send no webhooks, so the
 * hourly cron calls this to find ones the Setup URL didn't hand over. An uninstalled enterprise's row stays until its next
 * billing read fails; nothing else uses it.
 */
export async function syncEnterpriseInstallations(env: Env, db: Db, now = new Date()) {
  const installations = await listAppInstallations(await mainAppJwt(env));
  for (const installation of installations) {
    const enterprise = enterpriseInstallation(installation);
    if (enterprise) await upsertInstallation(db, enterprise, now);
  }
}

/**
 * Records one installation if it's on an enterprise, as the Setup URL hands it over. GitHub
 * vouches for it through the App's own JWT, and recording it grants nobody anything. Returns
 * the install when it was one on an enterprise.
 */
export async function recordEnterpriseInstallation(env: Env, db: Db, installationId: number) {
  let installation: AppInstallation | null;
  try {
    installation = await getAppInstallation(await mainAppJwt(env), installationId);
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: "enterprise installation read failed",
        installationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
  const enterprise = installation && enterpriseInstallation(installation);
  if (!enterprise) return null;
  await upsertInstallation(db, enterprise);
  return enterprise;
}

/**
 * Links the orgs an enterprise's usage report names to the enterprise, by matching them to the
 * App's org installs. An org's link moves if its enterprise changes.
 */
export async function linkEnterpriseOrganizations(
  db: Db,
  enterpriseInstallationId: number,
  orgLogins: Iterable<string>,
) {
  const logins = [...new Set([...orgLogins].map((login) => login.toLowerCase()))];
  if (!logins.length) return;
  const orgs = await db
    .select({ id: schema.githubInstallation.accountId })
    .from(schema.githubInstallation)
    .where(
      and(
        eq(schema.githubInstallation.accountType, "Organization"),
        inArray(sql`lower(${schema.githubInstallation.accountLogin})`, logins),
      ),
    );
  if (!orgs.length) return;
  await db
    .insert(schema.githubEnterpriseOrganization)
    .values(orgs.map((org) => ({ organizationId: org.id, enterpriseInstallationId })))
    .onConflictDoUpdate({
      target: schema.githubEnterpriseOrganization.organizationId,
      set: { enterpriseInstallationId, updatedAt: new Date() },
      // Only an org that moved enterprises is rewritten.
      setWhere: ne(
        schema.githubEnterpriseOrganization.enterpriseInstallationId,
        enterpriseInstallationId,
      ),
    });
}
