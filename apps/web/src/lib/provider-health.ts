import type { HostedProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";

/** A hosted provider runner type the Router skips because its last jobs weren't picked up. */
export type UnhealthyRunner = {
  key: HostedProviderId;
  label: string;
  // How many jobs in a row weren't picked up when it tripped.
  misses: number;
  // When the Router next lets one job through to try it.
  retryAt: number;
};

const path = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/provider-health`;

export async function getUnhealthyRunners(workspaceId: string) {
  return (await api<{ unhealthy: UnhealthyRunner[] }>(path(workspaceId))).unhealthy;
}

/** "Try again now": the Router sends jobs to the runner type again. */
export async function clearUnhealthyRunner(workspaceId: string, runner: UnhealthyRunner) {
  await api(`${path(workspaceId)}/${runner.key}/${encodeURIComponent(runner.label)}`, {
    method: "DELETE",
  });
}
