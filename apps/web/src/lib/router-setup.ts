import type { HostedProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";

/** One workflow in one repo over the window, and how many of its runs went through a relay. */
export type SetupWorkflow = {
  repositoryId: number;
  repository: string;
  workflow: string;
  runs: number;
  routedRuns: number;
  lastRunAt: number;
};

/** A hosted provider label the workspace's jobs ran on. */
export type LabelUse = { key: HostedProviderId; label: string; jobs: number };

/** Recent workflows, routed or not first, and the hosted labels jobs ran on, busiest first. */
export type RouterSetup = { days: number; workflows: SetupWorkflow[]; labels: LabelUse[] };

export function getRouterSetup(workspaceId: string) {
  return api<RouterSetup>(`/workspaces/${encodeURIComponent(workspaceId)}/router-setup`);
}

/** Example workflows for the Router page's `VITE_AUTH_DISABLED=true` dev preview. */
export function sampleRouterSetup(): RouterSetup {
  const at = Date.now() - 3_600_000;
  return {
    days: 14,
    workflows: [
      {
        repositoryId: 2,
        repository: "acme/site",
        workflow: "Deploy",
        runs: 9,
        routedRuns: 0,
        lastRunAt: at,
      },
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "CI",
        runs: 212,
        routedRuns: 208,
        lastRunAt: at,
      },
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "E2E",
        runs: 41,
        routedRuns: 41,
        lastRunAt: at,
      },
    ],
    labels: [
      { key: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404", jobs: 1_180 },
      { key: "blacksmith", label: "blacksmith-4vcpu-ubuntu-2404", jobs: 640 },
    ],
  };
}
