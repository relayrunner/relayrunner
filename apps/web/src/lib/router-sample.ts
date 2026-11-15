import type { AccountUsage } from "./actions-usage.ts";
import type { RouterSetup } from "./router-setup.ts";

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
    spendApp: true,
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
        spendApp: null,
        status: "not_available",
        reason: "sign_in_needed",
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

/** Example workflows for the Router page's `VITE_AUTH_DISABLED=true` dev preview. */
export function sampleRouterSetup(): RouterSetup {
  return {
    days: 14,
    workflows: [
      {
        repositoryId: 2,
        repository: "acme/site",
        workflow: "Deploy",
        runs: 9,
        routedRuns: 0,
      },
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "CI",
        runs: 212,
        routedRuns: 208,
      },
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "E2E",
        runs: 41,
        routedRuns: 41,
      },
    ],
    labels: [
      { key: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404", jobs: 1_180 },
      { key: "blacksmith", label: "blacksmith-4vcpu-ubuntu-2404", jobs: 640 },
    ],
  };
}
