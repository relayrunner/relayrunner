import type { HostedProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";

/** One workflow in one repo over the window, and how many of its runs went through a relay. */
export type SetupWorkflow = {
  repositoryId: number;
  repository: string;
  workflow: string;
  runs: number;
  routedRuns: number;
};

/** A hosted provider label the workspace's jobs ran on. */
export type LabelUse = { key: HostedProviderId; label: string; jobs: number };

/** Recent workflows, routed or not first, and the hosted labels jobs ran on, busiest first. */
export type RouterSetup = { days: number; workflows: SetupWorkflow[]; labels: LabelUse[] };

export function getRouterSetup(workspaceId: string) {
  return api<RouterSetup>(`/workspaces/${encodeURIComponent(workspaceId)}/router-setup`);
}
