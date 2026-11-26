import type { AccountUsage } from "../actions-usage.ts";
import type { AutoJob, AutoJobs } from "../auto-jobs.ts";
import type { RouterSetup, RunnerGroupCheck } from "../router-setup.ts";

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
      // Larger runners bill from the first minute, so a team under its included minutes still pays.
      netAmount: 18.4,
    },
  ];
}

/** Example repos and workflows for the Router page's `VITE_AUTH_DISABLED=true` dev preview. */
export function sampleRouterSetup(): RouterSetup {
  const job = (name: string, runs: number, minutes: number, legs = 1) => ({
    name,
    legs,
    label: "ubuntu-latest",
    runs,
    minutes,
  });
  const workflow = (
    repositoryId: number,
    repository: string,
    name: string,
    jobs: ReturnType<typeof job>[],
    routedRuns = 0,
  ) => ({
    repositoryId,
    repository,
    workflow: name,
    runs: Math.max(...jobs.map((j) => j.runs)),
    routedRuns,
    jobs,
  });
  return {
    days: 14,
    workflows: [
      workflow(3, "acme/api", "CI", [
        job("test", 420, 6),
        job("lint", 420, 1),
        job("e2e", 410, 9, 3),
      ]),
      workflow(3, "acme/api", "Release", [job("publish", 12, 3)]),
      workflow(4, "acme/web", "CI", [job("build", 310, 4), job("test", 310, 3)]),
      workflow(4, "acme/web", "Preview", [job("deploy-preview", 290, 2)]),
      workflow(5, "acme/docs", "Build", [job("build", 60, 2)]),
      workflow(1, "acme/app", "CI", [job("lint", 212, 1), job("test", 212, 7)], 208),
      workflow(2, "acme/site", "Preview", [job("build", 63, 3)], 63),
    ],
    labels: [
      { key: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404", jobs: 1_180 },
      { key: "blacksmith", label: "blacksmith-4vcpu-ubuntu-2404", jobs: 640 },
    ],
    repos: [
      { id: 3, fullName: "acme/api", private: true },
      { id: 1, fullName: "acme/app", private: true },
      { id: 5, fullName: "acme/docs", private: false },
      { id: 2, fullName: "acme/site", private: true },
      { id: 4, fullName: "acme/web", private: true },
      { id: 6, fullName: "acme/worker", private: true },
    ],
    accessUrl: "https://github.com/organizations/acme/settings/installations/1",
  };
}

/** A Default runner group that leaves acme/web out, for the dev preview's "Route a repo" sheet. */
export function sampleRunnerGroupCheck(): RunnerGroupCheck {
  return {
    groupName: "Default",
    settingsUrl: "https://github.com/organizations/acme/settings/actions/runner-groups/1",
    blocked: [{ repositoryId: 4, block: "not_selected" }],
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
    cpus: null,
    first: null,
    updatedAt: null,
    lastSeenAt: now - 3_600_000,
    canEdit: true,
    ...fields,
  });
  return {
    size: 2,
    jobs: [
      job(1, "relay-lint"),
      job(2, "relay-typecheck"),
      job(3, "relay-test", { size: 8, updatedAt: now - 2 * 86_400_000 }),
      job(4, "relay-build", { size: 4, first: "blacksmith" }),
      job(5, "relay", { workflowPath: ".github/workflows/e2e.yml", workflow: "E2E", cpus: 16 }),
    ],
  };
}
