import type { HostedProviderId } from "@relayrunner/providers";
import { useEffect, useState } from "react";
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

/**
 * The provider apps the org has installed, read from GitHub after the page loads. Null until it
 * arrives, or when it can't be told.
 */
export function useProviderApps(workspaceId: string) {
  const [installed, setInstalled] = useState<HostedProviderId[] | null>(null);
  useEffect(() => {
    let live = true;
    getProviderApps(workspaceId).then(
      (apps) => live && setInstalled(apps),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return installed;
}
