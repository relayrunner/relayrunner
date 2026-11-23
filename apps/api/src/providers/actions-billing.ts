// GitHub Actions minutes per GitHub account, read from each account's billing usage report (#116), so
// the minutes rule (#117) can stop sending jobs to GitHub-hosted runners before the account's
// included quota runs out. Everything is per installation (one GitHub account), never pooled
// across a workspace: each account has its own quota.
//
// Orgs are read with the RelayRunner Spend App's installation token when the org has installed it
// (src/github/spend-app.ts), falling back to the main App's (Organization Administration: read) if GitHub
// refuses it. An org that installed the main App before it asked for Organization Administration,
// and hasn't accepted it since, gets refused by both until it accepts or installs Spend.
// A personal account's report only opens to its owner's own user-to-server token (User permission
// Plan: read), so those are read with the token from the owner's RelayRunner sign-in (#208).
//
// An org inside a GitHub enterprise shares the enterprise's pooled minutes, which only an install
// on the enterprise can read (src/github/enterprise.ts). The poll reads each enterprise install's report
// too, and an enterprise org is judged against its enterprise's minutes.
//
// The cron polls every 15 minutes. GitHub's billing lags about 6-90 minutes and arrives in bursts
// (#115), which #117's burn-rate margin covers.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
} from "drizzle-orm";
import { recordOverage } from "../reports/activity.ts";
import { createAuth } from "../auth/auth.ts";
import { createDb, type Db, prepare, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { enqueueInstallationTasks } from "../github/installation-queue.ts";
import { linkEnterpriseOrganizations } from "../github/enterprise.ts";
import { userGitHubToken } from "../github/installations.ts";
import { spendAppToken, spendInstallationId } from "../github/spend-app.ts";
import {
  appInstallationToken,
  enterpriseBillingUsage,
  enterpriseBudgets,
  GitHubAccessError,
  orgBillingUsage,
  orgBudgets,
  orgPlan,
  userBillingUsage,
  userPlan,
  type BillingBudget,
  type BillingUsageItem,
} from "../github/github-app.ts";

/**
 * Included Actions minutes per plan. GitHub counts them in Linux 2-core minutes; other runners use
 * the quota faster, in proportion to their price. Personal accounts use the same names (free, pro).
 */
export const PLAN_QUOTA_MINUTES: Record<string, number> = { free: 2000, pro: 3000, team: 3000 };

// Enterprise orgs share their enterprise's pooled quota, which an org-level read can't see. Shown
// as "not available" until the App is installed on the enterprise too.
const ENTERPRISE_PLANS = new Set(["enterprise", "business_plus"]);

// Included Actions minutes for a GitHub Enterprise Cloud enterprise, shared by all its orgs.
export const ENTERPRISE_QUOTA_MINUTES = 50_000;

// USD per Linux 2-core minute (Nov 2026). Converts what a cycle's usage is worth into quota minutes,
// so a macOS minute counts as the ~10 Linux minutes of quota it uses.
const LINUX_MINUTE_USD = 0.006;

const HOUR_MS = 3_600_000;
// Burn rate looks at this much recent history.
export const BURN_WINDOW_MS = 2 * HOUR_MS;
// Shorter than this between the first and last reading in the window gives no burn rate.
const MIN_BURN_SPAN_MS = 10 * 60_000;
export const READING_RETENTION_MS = 48 * HOUR_MS;
// An account whose billing GitHub refused is read again after this long, or sooner once something
// that could fix it happens: the installation changes (permissions accepted, a member signs in) or
// the org installs the Spend App.
export const REFUSED_RETRY_MS = 6 * HOUR_MS;
// Failures that mean GitHub refused the read, as opposed to an error.
const REFUSALS = ["missing_permission", "enterprise_permission"];

export type AccountUsageReason =
  // An enterprise org, and the App isn't installed on its enterprise.
  | "enterprise"
  // The App is on the enterprise, but GitHub refused its billing: the enterprise owner hasn't
  // accepted the App's enterprise billing permission.
  | "enterprise_permission"
  | "missing_permission"
  // A personal account whose owner has no usable sign-in token in this workspace: they aren't a
  // member, never signed in, or their token stopped refreshing. Signing in again fixes it.
  | "sign_in_needed"
  | "unknown_plan"
  | "not_read_yet"
  | "error";

/** One GitHub account's Actions usage this cycle, as GET /api/usage/actions and #117 read it. */
export interface AccountUsage {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: "ok" | "not_available";
  // Why it's not available; null when status is "ok".
  reason: AccountUsageReason | null;
  plan: string | null;
  // From PLAN_QUOTA_MINUTES only. #117 applies its typed override on top.
  quotaMinutes: number | null;
  // Private-repo (and unknown-repo) Actions minutes this cycle, in Linux 2-core minutes.
  usedMinutes: number;
  // USD, private and unknown repos, this cycle, before discounts.
  grossAmount: number;
  // USD GitHub billed this cycle, all repos. Above 0 means the account went past its quota.
  netAmount: number;
  // Minutes per hour over the last two hours of readings; null with too few readings.
  burnRatePerHour: number | null;
  budget: { amountUsd: number; preventFurtherUsage: boolean } | null;
  cycleStart: string;
  readAt: string | null;
  // Whether the org installed the RelayRunner Spend App, which reads its billing. Null for a
  // personal account, whose billing is read with its owner's sign-in instead.
  spendApp: boolean | null;
  // The enterprise whose shared minutes these are (its slug), when the org is in one we read.
  // Every number above is then the enterprise's.
  enterprise: string | null;
}

/** The start of the billing cycle `now` is in: the UTC calendar month. */
export function cycleStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** One account the 15-minute poll reads, as its queue message carries it. */
export interface UsageAccount {
  id: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  workspaceId: string | null;
}

/**
 * The 15-minute poll: queues one read per connected, unsuspended installation
 * (src/github/installation-tasks.ts), so each account is read in its own consumer invocation however many
 * there are, and drops readings past retention. Accounts whose billing GitHub refused wait for
 * REFUSED_RETRY_MS or a change that could fix it.
 */
export async function pollActionsUsage(env: Env, now = new Date()) {
  const db = createDb(env.DB);
  const accounts: UsageAccount[] = await db
    .select({
      id: schema.githubInstallation.id,
      accountId: schema.githubInstallation.accountId,
      accountLogin: schema.githubInstallation.accountLogin,
      accountType: schema.githubInstallation.accountType,
      workspaceId: schema.workspace.id,
    })
    .from(schema.githubInstallation)
    .leftJoin(schema.workspace, eq(schema.workspace.installationId, schema.githubInstallation.id))
    .leftJoin(
      schema.actionsBilling,
      eq(schema.actionsBilling.installationId, schema.githubInstallation.id),
    )
    .leftJoin(
      schema.spendInstallation,
      eq(schema.spendInstallation.accountId, schema.githubInstallation.accountId),
    )
    .where(
      and(
        // Workspace installs, and enterprise installs (which have none).
        or(isNotNull(schema.workspace.id), eq(schema.githubInstallation.accountType, "Enterprise")),
        isNull(schema.githubInstallation.suspendedAt),
        or(
          isNull(schema.actionsBilling.failure),
          notInArray(schema.actionsBilling.failure, REFUSALS),
          lt(schema.actionsBilling.checkedAt, new Date(now.getTime() - REFUSED_RETRY_MS)),
          gt(schema.githubInstallation.githubStateAt, schema.actionsBilling.checkedAt),
          gt(schema.spendInstallation.createdAt, schema.actionsBilling.checkedAt),
        ),
      ),
    );
  await enqueueInstallationTasks(
    env,
    accounts.map((account) => ({ kind: "actions-usage", account, at: now.toISOString() })),
  );
  await db
    .delete(schema.actionsUsageReading)
    .where(lt(schema.actionsUsageReading.readAt, new Date(now.getTime() - READING_RETENTION_MS)));
}

/**
 * Read one account's usage (an org with the App's token, a personal account with its owner's). A
 * failure is recorded for the dashboard rather than thrown: the next poll tries again.
 */
export async function pollAccount(env: Env, account: UsageAccount, now: Date) {
  const db = createDb(env.DB);
  try {
    if (isPersonal(account)) {
      const token = await ownerToken(createAuth(env), db, account);
      if (!token) {
        await recordFailure(
          db,
          account.id,
          "sign_in_needed",
          "No sign-in token for the account's owner in this workspace",
          now,
        );
        return;
      }
      await pollInstallation(db, token, account, now);
      return;
    }
    const mainToken = () => appInstallationToken(env, account.id);
    if (account.accountType === "Enterprise") {
      await pollInstallation(db, await mainToken(), account, now);
      return;
    }
    const spend = await spendInstallationId(db, account.accountId);
    if (spend) await pollInstallation(db, await spendAppToken(env, spend), account, now, mainToken);
    else await pollInstallation(db, await mainToken(), account, now);
  } catch (error) {
    // Couldn't get a token (GitHub down, App removed before the webhook landed). Recorded so the
    // dashboard says why, and the next poll tries again.
    await recordFailure(db, account.id, "error", error, now);
    logFailure(account.id, error);
  }
}

const isPersonal = (installation: { accountType: string }) => installation.accountType === "User";

const accountKind = (accountType: string) =>
  accountType === "Enterprise" ? "enterprise" : accountType === "User" ? "user" : "org";

/**
 * The personal account owner's GitHub token, from their RelayRunner sign-in. Only the owner's
 * token can read the account's billing, and only while they're a member of the workspace the
 * installation belongs to: someone who left keeps their token out of it. Null when there's none.
 */
async function ownerToken(
  auth: ReturnType<typeof createAuth>,
  db: Db,
  installation: { accountId: number; workspaceId: string | null },
) {
  if (!installation.workspaceId) return null;
  const [owner] = await db
    .select({ userId: schema.account.userId })
    .from(schema.account)
    .innerJoin(
      schema.workspaceMember,
      and(
        eq(schema.workspaceMember.userId, schema.account.userId),
        eq(schema.workspaceMember.workspaceId, installation.workspaceId),
      ),
    )
    .where(
      and(
        eq(schema.account.providerId, "github"),
        eq(schema.account.accountId, String(installation.accountId)),
      ),
    )
    .limit(1);
  return owner ? userGitHubToken(auth, db, owner.userId) : null;
}

/**
 * Read one account's plan, budget and this month's usage, and store them. An org takes an
 * installation token; a personal account takes its owner's user token and has no budget to read
 * (GitHub has no budgets endpoint for users). If GitHub refuses the usage read and there's a
 * `fallback` token, the read is tried again with it.
 */
export async function pollInstallation(
  db: Db,
  token: string,
  installation: {
    id: number;
    accountLogin: string;
    accountType?: string;
    workspaceId?: string | null;
  },
  now = new Date(),
  fallback?: () => Promise<string>,
): Promise<void> {
  const org = installation.accountLogin;
  const kind = accountKind(installation.accountType ?? "Organization");
  const enterprise = kind === "enterprise";
  const start = cycleStart(now);
  const month = { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1 };
  const [plan, budgets, usage] = await Promise.allSettled([
    kind === "enterprise" ? "enterprise" : kind === "user" ? userPlan(token) : orgPlan(token, org),
    kind === "enterprise"
      ? enterpriseBudgets(token, org)
      : kind === "user"
        ? null
        : orgBudgets(token, org),
    kind === "enterprise"
      ? enterpriseBillingUsage(token, org, month)
      : kind === "user"
        ? userBillingUsage(token, org, month)
        : orgBillingUsage(token, org, month),
  ]);

  if (usage.status === "rejected") {
    const refused = usage.reason instanceof GitHubAccessError;
    if (refused && fallback) return pollInstallation(db, await fallback(), installation, now);
    await recordFailure(
      db,
      installation.id,
      refused ? (enterprise ? "enterprise_permission" : "missing_permission") : "error",
      usage.reason,
      now,
      { plan: plan.status === "fulfilled" ? plan.value : undefined },
    );
    // A refusal is the account's setup, not a fault: the dashboard says how to fix it, and the poll
    // backs off (REFUSED_RETRY_MS). Only unexpected failures log as errors.
    if (refused)
      console.log(
        JSON.stringify({ msg: "actions billing not shared", installationId: installation.id }),
      );
    else logFailure(installation.id, usage.reason);
    return;
  }

  const rows = aggregate(usage.value, start, enterprise);
  // Linked first: the enterprise's repo privacy comes from its orgs' installs.
  if (enterprise)
    await linkEnterpriseOrganizations(
      db,
      installation.id,
      usage.value.flatMap((item) => (item.organizationName ? [item.organizationName] : [])),
    );
  const privacy = enterprise
    ? await enterpriseRepoPrivacy(db, installation.id)
    : await repoPrivacy(db, installation.id, org);
  const totals = cycleTotals(rows, privacy);

  // A plan or budget read failing keeps what the last poll found rather than blanking it.
  const billing = {
    checkedAt: now,
    readAt: now,
    failure: null,
    error: null,
    ...(plan.status === "fulfilled" ? { plan: plan.value } : {}),
    ...(budgets.status === "fulfilled" && budgets.value
      ? actionsBudget(budgets.value, enterprise ? "enterprise" : "organization")
      : {}),
  };

  // GitHub sends the whole month on every poll, so the cycle's rows are simply replaced: nothing
  // to backfill, and a day GitHub revises later is picked up on the next poll. All rows go in one
  // statement as a JSON parameter, so a poll costs the same few D1 queries whatever the repo count.
  // Sent straight to D1 rather than through Drizzle's batch, which can't carry a raw statement.
  const d1 = db.$client;
  await d1.batch([
    prepare(
      db,
      db
        .delete(schema.actionsUsage)
        .where(
          and(
            eq(schema.actionsUsage.installationId, installation.id),
            eq(schema.actionsUsage.cycleStart, start),
          ),
        ),
    ),
    d1
      .prepare(
        `INSERT INTO actions_usage (installation_id, cycle_start, repository_name, sku, unit_type,
          quantity, gross_amount, net_amount, created_at, updated_at)
        SELECT ?1, ?2, value ->> 'repositoryName', value ->> 'sku', value ->> 'unitType',
          value ->> 'quantity', value ->> 'grossAmount', value ->> 'netAmount', ?3, ?3
        FROM json_each(?4)`,
      )
      .bind(installation.id, start.getTime(), now.getTime(), JSON.stringify(rows)),
    prepare(
      db,
      db.insert(schema.actionsUsageReading).values({
        installationId: installation.id,
        readAt: now,
        cycleStart: start,
        ...totals,
      }),
    ),
    prepare(
      db,
      db
        .insert(schema.actionsBilling)
        .values({ installationId: installation.id, ...billing })
        .onConflictDoUpdate({
          target: schema.actionsBilling.installationId,
          set: { ...billing, updatedAt: now },
        }),
    ),
  ]);

  // GitHub billed overage: the account went past its included minutes. The Activity log says so
  // once per cycle, and the dashboard shows a banner while netAmount stays above 0 (#117).
  if (totals.netAmount > 0 && installation.workspaceId)
    await recordOverage(db, {
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      account: org,
      cycleStart: start,
      netAmount: totals.netAmount,
    });
}

type UsageRow = Omit<
  typeof schema.actionsUsage.$inferInsert,
  "id" | "installationId" | "cycleStart" | "createdAt" | "updatedAt"
>;

// The cycle's Actions rows, summed over its days per repo and SKU.
function aggregate(items: BillingUsageItem[], start: Date, enterprise: boolean): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const item of items) {
    if (item.product.toLowerCase() !== "actions") continue;
    if (item.date.slice(0, 10) < dayOf(start)) continue;
    // An enterprise's rows span orgs, so they're kept as "org/repo".
    const repositoryName =
      enterprise && item.organizationName && item.repositoryName
        ? `${item.organizationName}/${item.repositoryName}`
        : (item.repositoryName ?? "");
    const key = JSON.stringify([repositoryName, item.sku]);
    const row = rows.get(key) ?? {
      repositoryName,
      sku: item.sku,
      unitType: item.unitType,
      quantity: 0,
      grossAmount: 0,
      netAmount: 0,
    };
    row.quantity += item.quantity;
    row.grossAmount += item.grossAmount;
    row.netAmount += item.netAmount;
    rows.set(key, row);
  }
  return [...rows.values()];
}

// Repo name (lowercased) to whether it's private, from the installation's mirrored repos.
async function repoPrivacy(db: Db, installationId: number, org: string) {
  const repos = await db
    .select({
      fullName: schema.githubRepository.fullName,
      private: schema.githubRepository.private,
    })
    .from(schema.githubRepository)
    .where(eq(schema.githubRepository.installationId, installationId));
  const prefix = `${org.toLowerCase()}/`;
  return new Map(
    repos
      .filter((repo) => repo.fullName.toLowerCase().startsWith(prefix))
      .map((repo) => [repo.fullName.slice(prefix.length).toLowerCase(), repo.private]),
  );
}

// "org/repo" (lowercased) to whether it's private, from the installs of an enterprise's orgs.
async function enterpriseRepoPrivacy(db: Db, installationId: number) {
  const repos = await db
    .select({
      fullName: schema.githubRepository.fullName,
      private: schema.githubRepository.private,
    })
    .from(schema.githubEnterpriseOrganization)
    .innerJoin(
      schema.githubInstallation,
      and(
        eq(schema.githubInstallation.accountId, schema.githubEnterpriseOrganization.organizationId),
        eq(schema.githubInstallation.accountType, "Organization"),
      ),
    )
    .innerJoin(
      schema.githubRepository,
      eq(schema.githubRepository.installationId, schema.githubInstallation.id),
    )
    .where(eq(schema.githubEnterpriseOrganization.enterpriseInstallationId, installationId));
  return new Map(repos.map((repo) => [repo.fullName.toLowerCase(), repo.private]));
}

// Runner minutes count toward the quota only in private repos. A repo we don't mirror (a
// select-repos install) counts as private, so a gap never hides usage.
function cycleTotals(
  rows: Pick<UsageRow, "repositoryName" | "unitType" | "grossAmount" | "netAmount">[],
  privacy: Map<string, boolean>,
) {
  let grossAmount = 0;
  let netAmount = 0;
  for (const row of rows) {
    netAmount += row.netAmount;
    if (row.unitType.toLowerCase() !== "minutes") continue;
    if (privacy.get(row.repositoryName.toLowerCase()) === false) continue;
    grossAmount += row.grossAmount;
  }
  return {
    usedMinutes: round(grossAmount / LINUX_MINUTE_USD, 1),
    grossAmount: round(grossAmount, 4),
    netAmount: round(netAmount, 4),
  };
}

// The account's own Actions budget: its scope, covering the whole Actions product.
function actionsBudget(budgets: BillingBudget[], scope: "organization" | "enterprise") {
  const budget = budgets.find(
    (b) =>
      b.scope === scope &&
      b.type === "ProductPricing" &&
      b.skus.some((sku) => sku.toLowerCase() === "actions"),
  );
  return {
    budgetAmount: budget?.amount ?? null,
    budgetPreventFurtherUsage: budget?.preventFurtherUsage ?? null,
  };
}

async function recordFailure(
  db: Db,
  installationId: number,
  failure: "missing_permission" | "enterprise_permission" | "sign_in_needed" | "error",
  error: unknown,
  now: Date,
  fields: { plan?: string | null } = {},
) {
  const values = {
    checkedAt: now,
    failure,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    ...(fields.plan !== undefined ? { plan: fields.plan } : {}),
  };
  await db
    .insert(schema.actionsBilling)
    .values({ installationId, ...values })
    .onConflictDoUpdate({
      target: schema.actionsBilling.installationId,
      set: { ...values, updatedAt: now },
    });
}

function logFailure(installationId: number, error: unknown) {
  console.error(
    JSON.stringify({
      msg: "actions usage poll failed",
      installationId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** One installation's usage this cycle, or null when there's no such installation. */
export async function accountUsage(
  db: Db,
  installationId: number,
  now = new Date(),
): Promise<AccountUsage | null> {
  const [installation] = await db
    .select({
      id: schema.githubInstallation.id,
      accountId: schema.githubInstallation.accountId,
      accountLogin: schema.githubInstallation.accountLogin,
      accountType: schema.githubInstallation.accountType,
      billing: schema.actionsBilling,
      spendInstallationId: schema.spendInstallation.installationId,
      spendSuspendedAt: schema.spendInstallation.suspendedAt,
      enterpriseInstallationId: schema.githubEnterpriseOrganization.enterpriseInstallationId,
    })
    .from(schema.githubInstallation)
    .leftJoin(
      schema.actionsBilling,
      eq(schema.actionsBilling.installationId, schema.githubInstallation.id),
    )
    .leftJoin(
      schema.spendInstallation,
      eq(schema.spendInstallation.accountId, schema.githubInstallation.accountId),
    )
    .leftJoin(
      schema.githubEnterpriseOrganization,
      and(
        eq(schema.githubEnterpriseOrganization.organizationId, schema.githubInstallation.accountId),
        eq(schema.githubInstallation.accountType, "Organization"),
      ),
    )
    .where(eq(schema.githubInstallation.id, installationId))
    .limit(1);
  if (!installation) return null;
  const enterprise = installation.accountType === "Enterprise";
  const spendApp = isPersonal(installation)
    ? null
    : installation.spendInstallationId !== null && !installation.spendSuspendedAt;

  // An org in an enterprise we read is judged against the enterprise's shared minutes.
  if (installation.enterpriseInstallationId !== null) {
    const shared = await accountUsage(db, installation.enterpriseInstallationId, now);
    if (shared)
      return {
        ...shared,
        installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        spendApp,
        enterprise: shared.accountLogin,
      };
  }

  const start = cycleStart(now);
  const billing = installation.billing;
  const plan = billing?.plan ?? null;
  const readThisCycle = !!billing?.readAt && billing.readAt >= start;

  const [totals, readings] = await Promise.all([
    // An enterprise's report spans every org's repos, so its routing reads take the totals the
    // last poll worked out rather than adding them up again on every job.
    enterprise ? latestTotals(db, installationId, start) : currentTotals(db, installation, start),
    db
      .select({
        readAt: schema.actionsUsageReading.readAt,
        usedMinutes: schema.actionsUsageReading.usedMinutes,
      })
      .from(schema.actionsUsageReading)
      .where(
        and(
          eq(schema.actionsUsageReading.installationId, installationId),
          eq(schema.actionsUsageReading.cycleStart, start),
          gte(schema.actionsUsageReading.readAt, new Date(now.getTime() - BURN_WINDOW_MS)),
        ),
      )
      .orderBy(asc(schema.actionsUsageReading.readAt)),
  ]);

  const reason: AccountUsageReason | null = billing?.failure
    ? (billing.failure as AccountUsageReason)
    : !readThisCycle
      ? "not_read_yet"
      : enterprise
        ? null
        : plan && ENTERPRISE_PLANS.has(plan)
          ? "enterprise"
          : !plan || !(plan in PLAN_QUOTA_MINUTES)
            ? "unknown_plan"
            : null;

  return {
    installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    status: reason ? "not_available" : "ok",
    reason,
    plan,
    quotaMinutes: enterprise
      ? ENTERPRISE_QUOTA_MINUTES
      : plan
        ? (PLAN_QUOTA_MINUTES[plan] ?? null)
        : null,
    ...totals,
    burnRatePerHour: burnRate(readings),
    budget:
      billing?.budgetAmount != null
        ? {
            amountUsd: billing.budgetAmount,
            preventFurtherUsage: billing.budgetPreventFurtherUsage ?? false,
          }
        : null,
    cycleStart: start.toISOString(),
    readAt: billing?.readAt?.toISOString() ?? null,
    spendApp,
    enterprise: null,
  };
}

// The cycle's totals, added up from its stored rows.
async function currentTotals(
  db: Db,
  installation: { id: number; accountLogin: string },
  start: Date,
) {
  const [rows, privacy] = await Promise.all([
    db
      .select()
      .from(schema.actionsUsage)
      .where(
        and(
          eq(schema.actionsUsage.installationId, installation.id),
          eq(schema.actionsUsage.cycleStart, start),
        ),
      ),
    repoPrivacy(db, installation.id, installation.accountLogin),
  ]);
  return cycleTotals(rows, privacy);
}

// The cycle's totals as the last successful poll stored them.
async function latestTotals(db: Db, installationId: number, start: Date) {
  const [reading] = await db
    .select({
      usedMinutes: schema.actionsUsageReading.usedMinutes,
      grossAmount: schema.actionsUsageReading.grossAmount,
      netAmount: schema.actionsUsageReading.netAmount,
    })
    .from(schema.actionsUsageReading)
    .where(
      and(
        eq(schema.actionsUsageReading.installationId, installationId),
        eq(schema.actionsUsageReading.cycleStart, start),
      ),
    )
    .orderBy(desc(schema.actionsUsageReading.readAt))
    .limit(1);
  return reading ?? { usedMinutes: 0, grossAmount: 0, netAmount: 0 };
}

// A refresh reads an account again only when its last read is older than this, so repeated clicks
// cost GitHub nothing.
export const REFRESH_MIN_MS = 60_000;

/**
 * Read the workspace's account again now, rather than waiting for the 15-minute poll, along with
 * its enterprise's: the one it's linked to, or for an enterprise org not linked yet, every enterprise
 * install (one just installed, or one whose report didn't name the org last time). Accounts read in
 * the last minute are skipped.
 */
export async function refreshWorkspaceUsage(env: Env, workspaceId: string, now = new Date()) {
  const db = createDb(env.DB);
  const [org] = await db
    .select({
      id: schema.githubInstallation.id,
      accountId: schema.githubInstallation.accountId,
      accountLogin: schema.githubInstallation.accountLogin,
      accountType: schema.githubInstallation.accountType,
      workspaceId: schema.workspace.id,
      plan: schema.actionsBilling.plan,
      enterpriseInstallationId: schema.githubEnterpriseOrganization.enterpriseInstallationId,
    })
    .from(schema.workspace)
    .innerJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .leftJoin(
      schema.actionsBilling,
      eq(schema.actionsBilling.installationId, schema.githubInstallation.id),
    )
    .leftJoin(
      schema.githubEnterpriseOrganization,
      eq(schema.githubEnterpriseOrganization.organizationId, schema.githubInstallation.accountId),
    )
    .where(and(eq(schema.workspace.id, workspaceId), isNull(schema.githubInstallation.suspendedAt)))
    .limit(1);
  if (!org) return;

  const enterpriseIds =
    org.enterpriseInstallationId !== null
      ? [org.enterpriseInstallationId]
      : org.plan && ENTERPRISE_PLANS.has(org.plan)
        ? (
            await db
              .select({ id: schema.githubInstallation.id })
              .from(schema.githubInstallation)
              .where(
                and(
                  eq(schema.githubInstallation.accountType, "Enterprise"),
                  isNull(schema.githubInstallation.suspendedAt),
                ),
              )
          ).map((row) => row.id)
        : [];
  const enterprises = enterpriseIds.length
    ? await db
        .select({
          id: schema.githubInstallation.id,
          accountId: schema.githubInstallation.accountId,
          accountLogin: schema.githubInstallation.accountLogin,
          accountType: schema.githubInstallation.accountType,
        })
        .from(schema.githubInstallation)
        .where(inArray(schema.githubInstallation.id, enterpriseIds))
    : [];

  const accounts: UsageAccount[] = [
    {
      id: org.id,
      accountId: org.accountId,
      accountLogin: org.accountLogin,
      accountType: org.accountType,
      workspaceId: org.workspaceId,
    },
    ...enterprises.map((enterprise) => ({ ...enterprise, workspaceId: null })),
  ];
  const checked = await db
    .select({ id: schema.actionsBilling.installationId, at: schema.actionsBilling.checkedAt })
    .from(schema.actionsBilling)
    .where(
      inArray(
        schema.actionsBilling.installationId,
        accounts.map((account) => account.id),
      ),
    );
  const fresh = new Set(
    checked.filter((row) => now.getTime() - row.at.getTime() < REFRESH_MIN_MS).map((row) => row.id),
  );
  // Enterprises first: reading one links its orgs, which the org's own read doesn't need but the
  // page's next read does.
  for (const account of accounts.reverse())
    if (!fresh.has(account.id)) await pollAccount(env, account, now);
}

/** Every installation in the workspace, for GET /api/usage/actions. */
export async function workspaceActionsUsage(db: Db, workspaceId: string, now = new Date()) {
  const installations = await db
    .select({ id: schema.githubInstallation.id })
    .from(schema.githubInstallation)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, schema.githubInstallation.id))
    .where(eq(schema.workspace.id, workspaceId))
    .orderBy(asc(schema.githubInstallation.accountLogin));
  const accounts = await Promise.all(
    installations.map((installation) => accountUsage(db, installation.id, now)),
  );
  return { accounts: accounts.filter((account) => account !== null) };
}

// Minutes per hour between the first and last reading in the window. Billing arrives in bursts, so
// this smooths over the window rather than looking at the last step.
export function burnRate(readings: { readAt: Date; usedMinutes: number }[]) {
  if (readings.length < 2) return null;
  const first = readings[0]!;
  const last = readings[readings.length - 1]!;
  const span = last.readAt.getTime() - first.readAt.getTime();
  if (span < MIN_BURN_SPAN_MS) return null;
  return round(Math.max(0, last.usedMinutes - first.usedMinutes) / (span / HOUR_MS), 1);
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
