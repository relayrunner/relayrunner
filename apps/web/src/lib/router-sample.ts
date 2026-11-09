import type { AccountUsage } from "./actions-usage.ts";

/** Example GitHub accounts for the Router page's `VITE_AUTH_DISABLED=true` dev preview and tests. */
export function sampleRouterAccounts(
  kind: "team" | "enterprise" | "personal" = "team",
): AccountUsage[] {
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
  if (kind === "personal")
    return [
      {
        ...base,
        accountLogin: "octocat",
        accountType: "User",
        status: "not_available",
        reason: "personal_account",
        plan: null,
        quotaMinutes: null,
        usedMinutes: 0,
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
