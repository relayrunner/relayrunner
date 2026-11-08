// GitHub Actions minutes per GitHub account, read from each org's billing usage report (#116), so
// the minutes rule (#117) can stop sending jobs to GitHub-hosted runners before the account's
// included quota runs out. Everything is per installation (one GitHub account), never pooled
// across a workspace: each account has its own quota.
//
// The cron polls every 15 minutes. GitHub's billing lags about 6-90 minutes and arrives in bursts
// (#115), which #117's burn-rate margin covers.
import { and, asc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { createDb, type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  appInstallationToken,
  GitHubAccessError,
  orgBillingUsage,
  orgBudgets,
  orgPlan,
  type BillingBudget,
  type BillingUsageItem,
} from "./github-app.ts";

/**
 * Included Actions minutes per plan. GitHub counts them in Linux 2-core minutes; other runners use
 * the quota faster, in proportion to their price.
 */
export const PLAN_QUOTA_MINUTES: Record<string, number> = { free: 2000, pro: 3000, team: 3000 };

// Enterprise orgs share their enterprise's pooled quota, which an org-level read can't see. Shown
// as "not available" until #117's typed quota covers them.
const ENTERPRISE_PLANS = new Set(["enterprise", "business_plus"]);

// USD per Linux 2-core minute (Nov 2026). Converts what a cycle's usage is worth into quota minutes,
// so a macOS minute counts as the ~10 Linux minutes of quota it uses.
const LINUX_MINUTE_USD = 0.006;

const HOUR_MS = 3_600_000;
// Burn rate looks at this much recent history.
export const BURN_WINDOW_MS = 2 * HOUR_MS;
// Shorter than this between the first and last reading in the window gives no burn rate.
const MIN_BURN_SPAN_MS = 10 * 60_000;
export const READING_RETENTION_MS = 48 * HOUR_MS;

export type AccountUsageReason =
  | "personal_account"
  | "enterprise"
  | "missing_permission"
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
}

/** The start of the billing cycle `now` is in: the UTC calendar month. */
export function cycleStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** Poll every connected, unsuspended org installation. One failing doesn't stop the rest. */
export async function pollActionsUsage(env: Env, now = new Date()) {
  const db = createDb(env.DB);
  const installations = await db
    .select({
      id: schema.githubInstallation.id,
      accountLogin: schema.githubInstallation.accountLogin,
    })
    .from(schema.githubInstallation)
    .where(
      and(
        isNotNull(schema.githubInstallation.workspaceId),
        isNull(schema.githubInstallation.suspendedAt),
        eq(schema.githubInstallation.accountType, "Organization"),
      ),
    );
  for (const installation of installations) {
    try {
      const token = await appInstallationToken(env, installation.id);
      await pollInstallation(db, token, installation, now);
    } catch (error) {
      // Couldn't get a token (GitHub down, App removed before the webhook landed). Recorded so the
      // dashboard says why, and the next poll tries again.
      await recordFailure(db, installation.id, "error", error, now);
      logFailure(installation.id, error);
    }
  }
  await db
    .delete(schema.actionsUsageReading)
    .where(lt(schema.actionsUsageReading.readAt, new Date(now.getTime() - READING_RETENTION_MS)));
}

/** Read one org's plan, budget and this month's usage, and store them. */
export async function pollInstallation(
  db: Db,
  token: string,
  installation: { id: number; accountLogin: string },
  now = new Date(),
) {
  const org = installation.accountLogin;
  const start = cycleStart(now);
  const [plan, budgets, usage] = await Promise.allSettled([
    orgPlan(token, org),
    orgBudgets(token, org),
    orgBillingUsage(token, org, { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1 }),
  ]);

  if (usage.status === "rejected") {
    const failure = usage.reason instanceof GitHubAccessError ? "missing_permission" : "error";
    await recordFailure(db, installation.id, failure, usage.reason, now, {
      plan: plan.status === "fulfilled" ? plan.value : undefined,
    });
    logFailure(installation.id, usage.reason);
    return;
  }

  const rows = aggregate(usage.value, start);
  const privacy = await repoPrivacy(db, installation.id, org);
  const totals = cycleTotals(rows, privacy);

  // A plan or budget read failing keeps what the last poll found rather than blanking it.
  const billing = {
    checkedAt: now,
    readAt: now,
    failure: null,
    error: null,
    ...(plan.status === "fulfilled" ? { plan: plan.value } : {}),
    ...(budgets.status === "fulfilled" ? actionsBudget(budgets.value) : {}),
  };

  // GitHub sends the whole month on every poll, so the cycle's rows are simply replaced: nothing
  // to backfill, and a day GitHub revises later is picked up on the next poll. All rows go in one
  // statement as a JSON parameter, so a poll costs the same few D1 queries whatever the repo count.
  // Sent straight to D1 rather than through Drizzle's batch, which can't carry a raw statement.
  const d1 = db.$client;
  const prepare = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
    const built = query.toSQL();
    return d1.prepare(built.sql).bind(...built.params);
  };
  await d1.batch([
    prepare(
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
      db.insert(schema.actionsUsageReading).values({
        installationId: installation.id,
        readAt: now,
        cycleStart: start,
        ...totals,
      }),
    ),
    prepare(
      db
        .insert(schema.actionsBilling)
        .values({ installationId: installation.id, ...billing })
        .onConflictDoUpdate({
          target: schema.actionsBilling.installationId,
          set: { ...billing, updatedAt: now },
        }),
    ),
  ]);
}

type UsageRow = Omit<
  typeof schema.actionsUsage.$inferInsert,
  "id" | "installationId" | "cycleStart" | "createdAt" | "updatedAt"
>;

// The cycle's Actions rows, summed over its days per repo and SKU.
function aggregate(items: BillingUsageItem[], start: Date): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const item of items) {
    if (item.product.toLowerCase() !== "actions") continue;
    if (item.date.slice(0, 10) < dayOf(start)) continue;
    const repositoryName = item.repositoryName ?? "";
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

// The org's own Actions budget: org scope, covering the whole Actions product.
function actionsBudget(budgets: BillingBudget[]) {
  const budget = budgets.find(
    (b) =>
      b.scope === "organization" &&
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
  failure: "missing_permission" | "error",
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
      accountLogin: schema.githubInstallation.accountLogin,
      accountType: schema.githubInstallation.accountType,
      billing: schema.actionsBilling,
    })
    .from(schema.githubInstallation)
    .leftJoin(
      schema.actionsBilling,
      eq(schema.actionsBilling.installationId, schema.githubInstallation.id),
    )
    .where(eq(schema.githubInstallation.id, installationId))
    .limit(1);
  if (!installation) return null;

  const start = cycleStart(now);
  const billing = installation.billing;
  const plan = billing?.plan ?? null;
  const readThisCycle = !!billing?.readAt && billing.readAt >= start;

  const [rows, privacy, readings] = await Promise.all([
    db
      .select()
      .from(schema.actionsUsage)
      .where(
        and(
          eq(schema.actionsUsage.installationId, installationId),
          eq(schema.actionsUsage.cycleStart, start),
        ),
      ),
    repoPrivacy(db, installationId, installation.accountLogin),
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

  const reason: AccountUsageReason | null =
    installation.accountType !== "Organization"
      ? "personal_account"
      : billing?.failure
        ? (billing.failure as AccountUsageReason)
        : !readThisCycle
          ? "not_read_yet"
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
    quotaMinutes: plan ? (PLAN_QUOTA_MINUTES[plan] ?? null) : null,
    ...cycleTotals(rows, privacy),
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
  };
}

/** Every installation in the workspace, for GET /api/usage/actions. */
export async function workspaceActionsUsage(db: Db, workspaceId: string, now = new Date()) {
  const installations = await db
    .select({ id: schema.githubInstallation.id })
    .from(schema.githubInstallation)
    .where(eq(schema.githubInstallation.workspaceId, workspaceId))
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
