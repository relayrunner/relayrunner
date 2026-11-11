// The opt-in RelayRunner Spend App reads org billing (Organization Administration: read), so the
// main App doesn't have to hold that permission. Which accounts installed it comes from its
// installation webhooks (/api/webhooks/github-spend, tagged app: "spend"), stored per GitHub account
// in spend_installation. The hourly cron reconciles that table with GET /app/installations, which
// also picks up installs from before the webhook was on and any delivery that was lost.
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq, lte, notInArray, sql } from "drizzle-orm";
import { createDb, type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  appInstallationToken,
  appJwt,
  importAppPrivateKey,
  listAppInstallations,
} from "./github-app.ts";

const credentials = (env: Env) => ({
  GITHUB_APP_ID: env.GITHUB_SPEND_APP_ID,
  GITHUB_APP_PRIVATE_KEY: env.GITHUB_SPEND_APP_PRIVATE_KEY,
});

/** An installation token for the Spend App's installation on this account. */
export const spendAppToken = (env: Env, installationId: number) =>
  appInstallationToken(credentials(env), installationId);

/** The account's active Spend App installation id, or null when it hasn't installed it. */
export async function spendInstallationId(db: Db, accountId: number) {
  const [row] = await db
    .select({
      installationId: schema.spendInstallation.installationId,
      suspendedAt: schema.spendInstallation.suspendedAt,
    })
    .from(schema.spendInstallation)
    .where(eq(schema.spendInstallation.accountId, accountId))
    .limit(1);
  return row && !row.suspendedAt ? row.installationId : null;
}

interface Observed {
  accountId: number;
  accountLogin: string;
  installationId: number;
  suspendedAt: Date | null;
}

async function upsert(db: Db, row: Observed, at: Date) {
  const values = { ...row, githubStateAt: at };
  await db
    .insert(schema.spendInstallation)
    .values(values)
    .onConflictDoUpdate({
      target: schema.spendInstallation.accountId,
      set: { ...values, updatedAt: at },
      setWhere: lte(schema.spendInstallation.githubStateAt, at),
    });
}

/** Keep spend_installation current from one of the Spend App's installation events. */
export async function recordSpendInstallation(
  db: Db,
  message: Extract<WebhookMessage, { event: "installation" }>,
) {
  const installation = message.installation;
  if (!installation?.account) return;
  const at = new Date(message.receivedAt);
  if (message.action === "deleted") {
    await db
      .delete(schema.spendInstallation)
      .where(
        and(
          eq(schema.spendInstallation.installationId, installation.id),
          lte(schema.spendInstallation.githubStateAt, at),
        ),
      );
    return;
  }
  await upsert(
    db,
    {
      accountId: installation.account.id,
      accountLogin: installation.account.login,
      installationId: installation.id,
      suspendedAt: installation.suspendedAt ? new Date(installation.suspendedAt) : null,
    },
    at,
  );
}

/** Make spend_installation match the Spend App's installations on GitHub. */
export async function syncSpendInstallations(env: Env, now = new Date()) {
  const key = await importAppPrivateKey(await env.GITHUB_SPEND_APP_PRIVATE_KEY.get());
  const installations = await listAppInstallations(await appJwt(env.GITHUB_SPEND_APP_ID, key));
  const db = createDb(env.DB);
  for (const installation of installations) {
    if (!installation.account) continue;
    await upsert(
      db,
      {
        accountId: installation.account.id,
        accountLogin: installation.account.login,
        installationId: installation.id,
        suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
      },
      now,
    );
  }
  const ids = installations.map((installation) => installation.id);
  await db
    .delete(schema.spendInstallation)
    .where(
      and(
        ids.length ? notInArray(schema.spendInstallation.installationId, ids) : sql`1`,
        lte(schema.spendInstallation.githubStateAt, now),
      ),
    );
}
