import { api } from "./api";
import { exact } from "./utils";

// Each connected GitHub account's Actions minutes this billing cycle, read from GitHub billing
// (#116, GET /api/usage/actions). Per account, never pooled: each has its own included quota. The
// shape mirrors AccountUsage in apps/api/src/actions-billing.ts.

export type AccountUsageReason =
  | "enterprise"
  | "enterprise_permission"
  | "missing_permission"
  | "sign_in_needed"
  | "unknown_plan"
  | "not_read_yet"
  | "error";

export interface AccountUsage {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: "ok" | "not_available";
  reason: AccountUsageReason | null;
  plan: string | null;
  // Included minutes from the plan (Free 2,000, Pro/Team 3,000). Null when unknown.
  quotaMinutes: number | null;
  // Private-repo minutes this cycle, in Linux 2-core minutes (a macOS minute counts ~10).
  usedMinutes: number;
  grossAmount: number;
  // USD GitHub billed this cycle. Above 0: the account went past its included minutes.
  netAmount: number;
  burnRatePerHour: number | null;
  budget: { amountUsd: number; preventFurtherUsage: boolean } | null;
  cycleStart: string;
  readAt: string | null;
  // Whether the org installed RelayRunner Spend. Null for a personal account.
  spendApp: boolean | null;
  // The enterprise whose shared minutes these are, when the org is in one RelayRunner reads.
  enterprise: string | null;
}

export interface ActionsUsage {
  accounts: AccountUsage[];
}

export function getActionsUsage() {
  return api<ActionsUsage>("/usage/actions");
}

/** Reads GitHub billing again now (at most once a minute per account) and returns the result. */
export function refreshActionsUsage() {
  return api<ActionsUsage>("/usage/actions/refresh", { method: "POST", body: "{}" });
}

/** Whether a "while under N%" GitHub step can judge this account. */
export const hasQuota = (account: AccountUsage) =>
  account.status === "ok" && account.quotaMinutes !== null;

/** Installs the RelayRunner Spend App, which reads an org's billing. */
export const SPEND_APP_INSTALL_URL = "https://github.com/apps/relayrunner-spend/installations/new";

/** Whether GitHub refused this org's billing and the Spend App would fix it. */
export const needsSpendApp = (account: AccountUsage) =>
  account.spendApp === false && account.reason === "missing_permission";

/** Why an account's minutes can't be judged, and what fixes it. Null when they can. */
export function unavailableText(account: AccountUsage): string | null {
  switch (account.reason) {
    case null:
      return null;
    case "enterprise":
      return "This org shares its enterprise's minutes, which GitHub only reports to the enterprise. An enterprise owner can install RelayRunner on the enterprise to share them.";
    case "enterprise_permission":
      return `GitHub refused to share ${account.enterprise ?? "the enterprise"}'s billing. An enterprise owner needs to accept RelayRunner's enterprise billing permission.`;
    case "missing_permission":
      return account.accountType === "Organization"
        ? "GitHub refused to share this org's billing. Install the RelayRunner Spend App on the org to share it."
        : `GitHub refused to share ${account.accountLogin}'s billing. ${account.accountLogin} needs to sign out of RelayRunner and sign in again to approve the App's Plan permission.`;
    case "sign_in_needed":
      return `GitHub only shows a personal account's minutes to its owner. ${account.accountLogin} needs to be a member of this workspace and sign in to RelayRunner again.`;
    case "unknown_plan":
      return `RelayRunner doesn't know the included minutes for the ${account.plan ?? "account's"} plan, so a minutes limit can't judge it.`;
    case "not_read_yet":
      return "Not read yet. RelayRunner reads billing every 15 minutes.";
    case "error":
      return "Couldn't read billing from GitHub. RelayRunner tries again every 15 minutes.";
  }
}

/** Sample accounts for previews without a signed-in API. */
export function sampleActionsUsage(): ActionsUsage {
  const now = new Date();
  const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const readAt = new Date(now.getTime() - 6 * 60_000).toISOString();
  const base = {
    accountType: "Organization",
    grossAmount: 0,
    budget: { amountUsd: 0, preventFurtherUsage: true },
    cycleStart,
    readAt,
    spendApp: true,
    enterprise: null,
  };
  return {
    accounts: [
      {
        ...base,
        installationId: 1,
        accountLogin: "relayrunner",
        status: "ok",
        reason: null,
        plan: "free",
        quotaMinutes: 2000,
        usedMinutes: 1640,
        netAmount: 0,
        burnRatePerHour: 38,
      },
      {
        ...base,
        installationId: 2,
        accountLogin: "acme-labs",
        status: "ok",
        reason: null,
        plan: "team",
        quotaMinutes: 3000,
        usedMinutes: 3112,
        netAmount: 0.67,
        burnRatePerHour: 54,
        budget: null,
      },
      {
        ...base,
        installationId: 3,
        accountLogin: "bigco",
        status: "not_available",
        reason: "enterprise",
        plan: "enterprise",
        quotaMinutes: null,
        usedMinutes: 18200,
        netAmount: 0,
        burnRatePerHour: 210,
        budget: null,
      },
      {
        ...base,
        accountType: "User",
        spendApp: null,
        installationId: 4,
        accountLogin: "octocat",
        status: "ok",
        reason: null,
        plan: "free",
        quotaMinutes: 2000,
        usedMinutes: 420,
        netAmount: 0,
        burnRatePerHour: 6,
        budget: null,
      },
    ],
  };
}

const DAY_MS = 86_400_000;

/** When a billing cycle that started on `cycleStart` (a UTC day) resets: a month on. */
function cycleEnd(cycleStart: string) {
  const start = new Date(`${cycleStart.slice(0, 10)}T00:00:00Z`);
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
}

const dayText = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Where the month is headed at its pace so far: when the included minutes run out, or roughly what
 * it will have used by the reset. Null when there's no quota or too little of the month to tell.
 */
export function paceText(usage: AccountUsage, now = Date.now()) {
  const quota = usage.quotaMinutes;
  if (usage.status !== "ok" || quota === null) return null;
  const start = Date.parse(`${usage.cycleStart.slice(0, 10)}T00:00:00Z`);
  const end = cycleEnd(usage.cycleStart);
  const elapsed = now - start;
  if (elapsed < DAY_MS || now >= end || usage.usedMinutes >= quota) return null;
  const perMs = usage.usedMinutes / elapsed;
  const projected = usage.usedMinutes + perMs * (end - now);
  if (projected <= quota)
    return `At this pace, about ${exact(Math.round(projected))} of ${exact(quota)} min by ${dayText(end)}.`;
  const runsOut = now + (quota - usage.usedMinutes) / perMs;
  return `At this pace the included minutes run out around ${dayText(runsOut)}, before the ${dayText(end)} reset.`;
}
