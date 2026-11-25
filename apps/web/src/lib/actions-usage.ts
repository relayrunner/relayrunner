import { api } from "./api";
import { shortDate, utcShortDate } from "./time-zone";
import { count, exact } from "./utils";

// Each connected GitHub account's Actions minutes this billing cycle, read from GitHub billing
// (#116, GET /api/usage/actions). Per account, never pooled: each has its own included quota. The
// shape mirrors AccountUsage in apps/api/src/providers/actions-billing.ts.
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
  // Where the cycle is headed at the recent pace (apps/api/src/providers/minutes-projection.ts).
  // Null without a quota or on the cycle's first day.
  projection?: MinutesProjection | null;
}

export interface MinutesProjection {
  // runs_out: before the reset. over: already past the included minutes. surplus: a quarter or
  // more will go unused. on_track: most get used, and they last.
  outlook: "runs_out" | "over" | "surplus" | "on_track";
  minutesPerDay: number;
  // Quota minutes used by the reset at this pace.
  projectedMinutes: number;
  runsOutAt: string | null;
  resetsAt: string;
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

/**
 * Where the cycle is headed at the recent pace: when the included minutes run out, or how many will
 * go unused by the reset. Null without a projection.
 */
export function paceText(usage: AccountUsage) {
  const projection = usage.projection;
  const quota = usage.quotaMinutes;
  if (!projection || quota === null) return null;
  const { projectedMinutes: projected, runsOutAt } = projection;
  const reset = utcShortDate(projection.resetsAt);
  switch (projection.outlook) {
    case "runs_out":
      return `At this pace, included minutes run out around ${shortDate(Date.parse(runsOutAt!))}. GitHub bills jobs after that, until the ${reset} reset.`;
    case "over":
      return `At this pace, about ${exact(Math.round(projected - quota))} more billed min by the ${reset} reset.`;
    case "surplus":
      return `At this pace, about ${count(quota - projected)} of ${count(quota)} min go unused by the ${reset} reset.`;
    case "on_track":
      return `At this pace, about ${count(projected)} of ${count(quota)} min used by the ${reset} reset.`;
  }
}
