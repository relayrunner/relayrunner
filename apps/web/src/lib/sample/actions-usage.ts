// The GitHub accounts' minutes for the dev preview (lib/sample/answers.ts), like GET /api/usage/actions.
import type { ActionsUsage } from "../actions-usage.ts";
import { sampleParam } from "./param.ts";
import { sampleRouterAccounts } from "./router-setup.ts";

/**
 * The GitHub accounts' minutes, in several states. The Router page's `?sample=enterprise` and
 * `?sample=personal` show one account of that kind instead, and `?sample=default` none.
 */
export function sampleActionsUsage(): ActionsUsage {
  const sample = sampleParam();
  if (sample === "default") return { accounts: [] };
  if (sample === "enterprise" || sample === "personal")
    return { accounts: sampleRouterAccounts(sample) };
  const now = new Date();
  const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const readAt = new Date(now.getTime() - 6 * 60_000).toISOString();
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();
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
        projection: {
          outlook: "runs_out",
          minutesPerDay: 140,
          projectedMinutes: 2480,
          runsOutAt: inDays(2.6),
          resetsAt,
        },
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
        projection: {
          outlook: "over",
          minutesPerDay: 210,
          projectedMinutes: 4380,
          runsOutAt: null,
          resetsAt,
        },
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
        projection: {
          outlook: "surplus",
          minutesPerDay: 18,
          projectedMinutes: 530,
          runsOutAt: null,
          resetsAt,
        },
        budget: null,
      },
    ],
  };
}
