import type { HostedProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";

/**
 * The hosted providers whose GitHub App the workspace's org has installed, or null when that
 * can't be told (a personal account, or GitHub didn't answer).
 */
export async function getProviderApps(workspaceId: string) {
  const { installed } = await api<{ installed: HostedProviderId[] | null }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/provider-apps`,
  );
  return installed;
}
