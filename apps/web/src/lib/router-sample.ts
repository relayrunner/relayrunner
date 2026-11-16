import type { AccountUsage } from "./actions-usage.ts";
import type { AutoJob, AutoJobs } from "./auto-jobs.ts";
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
    enterprise: null,
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
      {
        repositoryId: 2,
        repository: "acme/site",
        workflow: "Preview",
        runs: 63,
        routedRuns: 63,
      },
    ],
    labels: [
      { key: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404", jobs: 1_180 },
      { key: "blacksmith", label: "blacksmith-4vcpu-ubuntu-2404", jobs: 640 },
    ],
  };
}

/** Example auto jobs for the Router page's `VITE_AUTH_DISABLED=true` dev preview. */
export function sampleAutoJobs(): AutoJobs {
  const now = Date.now();
  const job = (id: number, relayJob: string, fields: Partial<AutoJob> = {}): AutoJob => ({
    id,
    repositoryId: 1,
    repository: "acme/app",
    workflowPath: ".github/workflows/ci.yml",
    workflow: "CI",
    relayJob,
    size: null,
    first: null,
    updatedAt: null,
    lastSeenAt: now - 3_600_000,
    ...fields,
  });
  return {
    size: 2,
    jobs: [
      job(1, "relay-lint"),
      job(2, "relay-typecheck"),
      job(3, "relay-test", { size: 8, updatedAt: now - 2 * 86_400_000 }),
      job(4, "relay-build", { size: 4, first: "blacksmith" }),
      job(5, "relay", { workflowPath: ".github/workflows/e2e.yml", workflow: "E2E" }),
    ],
  };
}
