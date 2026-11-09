import { api } from "./api.ts";

/** Why an account's usage can't be judged against a quota. Null when it can. */
export type AccountUsageReason =
  | "personal_account"
  | "enterprise"
  | "missing_permission"
  | "unknown_plan"
  | "not_read_yet"
  | "error";

/** One connected GitHub account's Actions minutes this month (GET /api/usage/actions, #116). */
export type AccountUsage = {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: "ok" | "not_available";
  reason: AccountUsageReason | null;
  plan: string | null;
  /** Included minutes from the account's plan. Null when GitHub doesn't tell us (Enterprise). */
  quotaMinutes: number | null;
  /** Private-repo minutes this month, in Linux 2-core minutes. */
  usedMinutes: number;
  grossAmount: number;
  netAmount: number;
  burnRatePerHour: number | null;
  budget: { amountUsd: number; preventFurtherUsage: boolean } | null;
  cycleStart: string;
  readAt: string | null;
};

export function getActionsUsage() {
  return api<{ accounts: AccountUsage[] }>("/usage/actions");
}

/** An account a minutes limit can judge: its plan's quota is known. */
export const hasQuota = (account: AccountUsage) =>
  account.status === "ok" && account.quotaMinutes !== null;

/** "Team", "Pro", ... for the plan names GitHub reports. */
export function planName(plan: string | null) {
  if (!plan) return null;
  if (plan === "business_plus") return "Enterprise";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Example accounts for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleActionsUsage(kind: "team" | "enterprise" = "team"): AccountUsage[] {
  const cycleStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  ).toISOString();
  const base = {
    installationId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    grossAmount: 0,
    netAmount: 0,
    burnRatePerHour: 14,
    budget: null,
    cycleStart,
    readAt: new Date().toISOString(),
  };
  if (kind === "enterprise")
    return [
      {
        ...base,
        status: "not_available",
        reason: "enterprise",
        plan: "enterprise",
        quotaMinutes: null,
        usedMinutes: 31_400,
      },
    ];
  return [
    {
      ...base,
      status: "ok",
      reason: null,
      plan: "team",
      quotaMinutes: 3000,
      usedMinutes: 2520,
    },
  ];
}
