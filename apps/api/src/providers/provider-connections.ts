// Connecting a third-party provider account for real usage (Settings → Providers): save, test and
// remove a workspace's read-only token, and list what each connection has synced. Tokens go in
// encrypted and never come back out (src/providers/provider-tokens.ts).
import {
  BILLING_PROVIDER_IDS,
  BILLING_PROVIDERS,
  type BillingProviderId,
  defaultBillingOptions,
} from "@relayrunner/providers";
import { canManage } from "@relayrunner/api-types";
import { and, count, eq, gte, sum } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { enqueueInstallationTasks } from "../github/installation-queue.ts";
import { type AdapterContext, ADAPTERS, ProviderAuthError } from "../provider-billing/index.ts";
import { adapterTools, byConnection, NO_FAILURE, syncTask } from "./provider-sync.ts";
import { openToken, sealToken, tokenHint } from "./provider-tokens.ts";
import { errorMessage } from "../errors.ts";
import { log } from "../log.ts";

const DAY_MS = 86_400_000;
// The connection list sums this much recent usage.
const SUMMARY_DAYS = 30;

export type ConnectionFailure = "token_rejected" | "error";

/** What the dashboard sees of one provider: whether it's connected, and never the token. */
export interface ProviderConnectionView {
  provider: BillingProviderId;
  connected: boolean;
  tokenHint: string | null;
  accountName: string | null;
  options: Record<string, string>;
  lastSyncedAt: string | null;
  failure: ConnectionFailure | null;
  error: string | null;
  failedAt: string | null;
  // The last SUMMARY_DAYS days of synced jobs. costUsd is null when the provider reports only time.
  recent: { jobs: number; billableMinutes: number; costUsd: number | null };
}

type ConnectionRow = typeof schema.providerConnection.$inferSelect;

/** Every connectable provider, or just `only`, as the workspace has it. */
export async function listConnections(
  db: Db,
  workspaceId: string,
  now = new Date(),
  only?: BillingProviderId,
): Promise<ProviderConnectionView[]> {
  const since = new Date(now.getTime() - SUMMARY_DAYS * DAY_MS);
  const ofProvider = (column: SQLiteColumn) => (only ? eq(column, only) : undefined);
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(schema.providerConnection)
      .where(
        and(
          eq(schema.providerConnection.workspaceId, workspaceId),
          ofProvider(schema.providerConnection.provider),
        ),
      ),
    db
      .select({
        provider: schema.providerJobUsage.provider,
        jobs: count(),
        billableSeconds: sum(schema.providerJobUsage.billableSeconds),
        costUsd: sum(schema.providerJobUsage.costUsd),
      })
      .from(schema.providerJobUsage)
      .where(
        and(
          eq(schema.providerJobUsage.workspaceId, workspaceId),
          gte(schema.providerJobUsage.finishedAt, since),
          ofProvider(schema.providerJobUsage.provider),
        ),
      )
      .groupBy(schema.providerJobUsage.provider),
  ]);
  return (only ? [only] : BILLING_PROVIDER_IDS).map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    const total = totals.find((t) => t.provider === provider);
    return present(provider, row, {
      jobs: total?.jobs ?? 0,
      billableMinutes: Math.round(Number(total?.billableSeconds ?? 0) / 60),
      costUsd: total?.costUsd == null ? null : Number(total.costUsd),
    });
  });
}

function present(
  provider: BillingProviderId,
  row: ConnectionRow | undefined,
  recent: ProviderConnectionView["recent"],
): ProviderConnectionView {
  return {
    provider,
    connected: !!row,
    tokenHint: row?.tokenHint ?? null,
    accountName: row?.accountName ?? null,
    options: row?.options ?? defaultBillingOptions(provider),
    lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    failure: (row?.failure as ConnectionFailure | null) ?? null,
    error: row?.error ?? null,
    failedAt: row?.failedAt?.toISOString() ?? null,
    recent,
  };
}

// A GitHub organization's login.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The options a provider takes, with its defaults filled in; null when one isn't a choice it
 * offers. A provider on a GitHub organization also takes the `organization` the token was made
 * for, which connectProvider checks against the workspace's.
 */
export function parseOptions(
  provider: BillingProviderId,
  given: Record<string, string> | undefined,
): Record<string, string> | null {
  const info = BILLING_PROVIDERS[provider];
  const options = defaultBillingOptions(provider);
  for (const [key, raw] of Object.entries(given ?? {})) {
    if (key === "organization" && info.githubOrganization) {
      const value = raw.trim();
      if (!value) continue;
      if (!GITHUB_LOGIN.test(value)) return null;
      options[key] = value;
      continue;
    }
    const option = info.options?.find((o) => o.key === key);
    if (!option?.choices.some((choice) => choice.value === raw)) return null;
    options[key] = raw;
  }
  return options;
}

/** The GitHub account a workspace is installed on. */
async function workspaceLogin(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ login: schema.githubInstallation.accountLogin })
    .from(schema.workspace)
    .innerJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .where(eq(schema.workspace.id, workspaceId))
    .limit(1);
  return row?.login ?? null;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function organizationMismatch(given: string, login: string) {
  return {
    ok: false as const,
    error: "PROVIDER_ORGANIZATION_MISMATCH" as const,
    message: `The token is for ${given}, and this workspace is ${login}.`,
  };
}

export type VerifyResult =
  | { ok: true; accountName: string | null }
  | {
      ok: false;
      error: "PROVIDER_TOKEN_REJECTED" | "PROVIDER_UNREACHABLE" | "PROVIDER_ORGANIZATION_MISMATCH";
      message: string;
    };

/** One read with the token, to check it before saving it or when asked to test it. */
export async function verifyToken(
  provider: BillingProviderId,
  token: string,
  options: Record<string, string>,
  tools: Pick<AdapterContext, "fetch" | "cli"> = { fetch },
): Promise<VerifyResult> {
  try {
    const { accountName } = await ADAPTERS[provider].verify({ token, options, ...tools });
    return { ok: true, accountName };
  } catch (error) {
    const message = errorMessage(error);
    return error instanceof ProviderAuthError
      ? { ok: false, error: "PROVIDER_TOKEN_REJECTED", message }
      : { ok: false, error: "PROVIDER_UNREACHABLE", message };
  }
}

async function connectionView(db: Db, workspaceId: string, provider: BillingProviderId) {
  const [view] = await listConnections(db, workspaceId, new Date(), provider);
  return view!;
}

type Failed = Extract<VerifyResult, { ok: false }>;

/**
 * Save (or replace) a provider token once one read proves it works, then queue its first sync. A
 * new token starts the sync over, since it may belong to another account. Throws TokenKeyError
 * when tokens can't be encrypted here.
 */
export async function connectProvider(
  env: Env,
  db: Db,
  {
    workspaceId,
    provider,
    token,
    options,
    userId,
  }: {
    workspaceId: string;
    provider: BillingProviderId;
    token: string;
    options: Record<string, string>;
    userId: string;
  },
): Promise<Failed | { ok: true; connection: ProviderConnectionView }> {
  // A provider on a GitHub organization connects for the workspace's own: a token made for
  // another organization is refused, before and after it's read with.
  const login = BILLING_PROVIDERS[provider].githubOrganization
    ? await workspaceLogin(db, workspaceId)
    : null;
  if (login) {
    if (options.organization && !sameLogin(options.organization, login))
      return organizationMismatch(options.organization, login);
    options = { ...options, organization: login };
  }
  const verified = await verifyToken(provider, token, options, adapterTools(env, workspaceId));
  if (!verified.ok) return verified;
  if (login && verified.accountName && !sameLogin(verified.accountName, login))
    return organizationMismatch(verified.accountName, login);
  const values = {
    token: await sealToken(env, workspaceId, provider, token),
    tokenHint: tokenHint(token),
    options,
    accountName: verified.accountName,
    connectedBy: userId,
    syncedThrough: null,
    lastSyncedAt: null,
    ...NO_FAILURE,
  };
  await db
    .insert(schema.providerConnection)
    .values({ workspaceId, provider, ...values })
    .onConflictDoUpdate({
      target: [schema.providerConnection.workspaceId, schema.providerConnection.provider],
      set: values,
    });
  // The hourly cron syncs it anyway, so a queue hiccup only delays the first numbers.
  await enqueueInstallationTasks(env, [syncTask(workspaceId, provider)]).catch((error) =>
    log.warn("provider.sync_not_queued", "couldn't queue provider sync", { error }),
  );
  return { ok: true, connection: await connectionView(db, workspaceId, provider) };
}

/**
 * Check a saved token still works, refreshing the account name, and record a refusal the way a
 * sync would. Null when nothing is connected. Throws TokenKeyError like connectProvider.
 */
export async function testConnection(
  env: Env,
  db: Db,
  workspaceId: string,
  provider: BillingProviderId,
): Promise<(VerifyResult & { connection: ProviderConnectionView }) | null> {
  const where = byConnection(schema.providerConnection, workspaceId, provider);
  const [row] = await db.select().from(schema.providerConnection).where(where).limit(1);
  if (!row) return null;
  const token = await openToken(env, workspaceId, provider, row.token);
  const verified = await verifyToken(provider, token, row.options, adapterTools(env, workspaceId));
  const update = verified.ok
    ? { accountName: verified.accountName, ...NO_FAILURE }
    : verified.error === "PROVIDER_TOKEN_REJECTED"
      ? { failure: "token_rejected", error: verified.message, failedAt: new Date() }
      : null;
  if (update) await db.update(schema.providerConnection).set(update).where(where);
  return { ...verified, connection: await connectionView(db, workspaceId, provider) };
}

/** Forget a provider's token and everything synced with it. */
export async function disconnectProvider(db: Db, workspaceId: string, provider: BillingProviderId) {
  await db.batch([
    db
      .delete(schema.providerConnection)
      .where(byConnection(schema.providerConnection, workspaceId, provider)),
    db
      .delete(schema.providerJobUsage)
      .where(byConnection(schema.providerJobUsage, workspaceId, provider)),
    db
      .delete(schema.providerDailyUsage)
      .where(byConnection(schema.providerDailyUsage, workspaceId, provider)),
  ]);
  return present(provider, undefined, { jobs: 0, billableMinutes: 0, costUsd: null });
}

/** A workspace its user owns or administers, with the GitHub account it's installed on. */
export interface ManagedWorkspace {
  id: string;
  name: string;
  slug: string;
  accountLogin: string | null;
}

/** The workspaces a user may connect providers in. */
export async function managedWorkspaces(db: Db, userId: string): Promise<ManagedWorkspace[]> {
  const rows = await db
    .select({
      id: schema.workspace.id,
      name: schema.workspace.name,
      slug: schema.workspace.slug,
      accountLogin: schema.githubInstallation.accountLogin,
      role: schema.workspaceMember.role,
    })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    .leftJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .where(eq(schema.workspaceMember.userId, userId))
    .orderBy(schema.workspaceMember.createdAt, schema.workspace.id);
  return rows
    .filter((row) => canManage(row.role))
    .map(({ id, name, slug, accountLogin }) => ({ id, name, slug, accountLogin }));
}

/**
 * Which workspace a connection from the CLI goes to: the one it names (by id, slug or name), else
 * the only one installed on the token's GitHub organization, else the only one whose slug or name
 * is the organization. Without an organization, the user's only workspace. Null when that's none
 * or more than one, for the CLI to ask.
 */
export function chooseWorkspace(
  workspaces: ManagedWorkspace[],
  organization: string | undefined,
  wanted: string | undefined,
): ManagedWorkspace | null {
  if (wanted) {
    const named = wanted.toLowerCase();
    return (
      workspaces.find((w) => w.id === wanted) ??
      workspaces.find((w) => w.slug.toLowerCase() === named) ??
      workspaces.find((w) => w.name.toLowerCase() === named) ??
      null
    );
  }
  if (!organization) return workspaces.length === 1 ? workspaces[0]! : null;
  const only = (matches: ManagedWorkspace[]) => (matches.length === 1 ? matches[0]! : null);
  return (
    only(workspaces.filter((w) => w.accountLogin && sameLogin(w.accountLogin, organization))) ??
    only(
      workspaces.filter((w) => sameLogin(w.slug, organization) || sameLogin(w.name, organization)),
    )
  );
}
