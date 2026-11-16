import type { RunnerKey } from "@relayrunner/runner-order";
import { api } from "@/lib/api";

/** A job whose relay hands its runner to the Router (`auto`), and what the Router page set for it. */
export type AutoJob = {
  id: number;
  repositoryId: number;
  repository: string;
  workflowPath: string;
  workflow: string | null;
  relayJob: string;
  // vCPUs, or null for the workspace's default size.
  size: number | null;
  // The provider tried before the rest of the runner order, or null for the order as it is.
  first: RunnerKey | null;
  updatedAt: number | null;
  lastSeenAt: number;
};

/** The workspace's default size for auto jobs, in vCPUs, and its auto jobs. */
export type AutoJobs = { size: number; jobs: AutoJob[] };

const path = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`;

export function getAutoJobs(workspaceId: string) {
  return api<AutoJobs>(`${path(workspaceId)}/auto-jobs`);
}

/** Sets the default size for auto jobs. Owners and admins only. */
export async function setAutoSize(workspaceId: string, size: number) {
  await api(`${path(workspaceId)}/auto-size`, { method: "PUT", body: JSON.stringify({ size }) });
}

/** Sets one auto job's size and first provider. Owners and admins only. */
export async function setAutoJob(
  workspaceId: string,
  id: number,
  setting: Pick<AutoJob, "size" | "first">,
) {
  await api(`${path(workspaceId)}/auto-jobs/${id}`, {
    method: "PUT",
    body: JSON.stringify(setting),
  });
}

/** The job's name as people read it: `test` for the relay job `relay-test`. */
export const autoJobName = (job: Pick<AutoJob, "relayJob">) =>
  job.relayJob.replace(/^relay[-_]/, "") || job.relayJob;
