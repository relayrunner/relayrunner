import type { HostedProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";

/** One workflow in one repo over the window, and how many of its runs went through a relay. */
export type SetupWorkflow = {
  repositoryId: number;
  repository: string;
  workflow: string;
  runs: number;
  routedRuns: number;
  /** Its jobs, busiest first, with a matrix's legs as one job. */
  jobs: SetupJob[];
};

/** A job in a workflow, by the name GitHub shows. `minutes` is its usual time on a success. */
export type SetupJob = {
  name: string;
  legs: number;
  label: string | null;
  runs: number;
  minutes: number | null;
};

/** A repo the GitHub App can see. */
export type SetupRepo = { id: number; fullName: string; private: boolean };

/** A hosted provider label the workspace's jobs ran on. */
export type LabelUse = { key: HostedProviderId; label: string; jobs: number };

/**
 * Recent workflows, not routed first, the hosted labels jobs ran on, busiest first, the repos the
 * App sees, and where an owner changes which repos those are.
 */
export type RouterSetup = {
  days: number;
  workflows: SetupWorkflow[];
  labels: LabelUse[];
  repos: SetupRepo[];
  accessUrl: string | null;
};

export function getRouterSetup(workspaceId: string) {
  return api<RouterSetup>(`/workspaces/${encodeURIComponent(workspaceId)}/router-setup`);
}

/** Why the org's Default runner group keeps a repo's relay job from RelayRunner. */
export type RunnerGroupBlock = "public" | "private_only" | "not_selected";

/** The repos the org's Default runner group leaves out. */
export type RunnerGroupCheck = {
  groupName: string;
  settingsUrl: string;
  blocked: { repositoryId: number; block: RunnerGroupBlock }[];
};

/** Null for a personal account, or when GitHub couldn't be read. */
export async function getRunnerGroupCheck(workspaceId: string) {
  const { check } = await api<{ check: RunnerGroupCheck | null }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/runner-group-check`,
  );
  return check;
}

/** Saves sizes for jobs that don't route yet, for their first run. Answers the jobs it saved. */
export async function planSizes(
  workspaceId: string,
  repositoryId: number,
  jobs: { workflow: string; job: string; size: number }[],
) {
  const { planned } = await api<{ planned: typeof jobs }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/planned-sizes`,
    { method: "PUT", body: JSON.stringify({ repositoryId, jobs }) },
  );
  return planned;
}
