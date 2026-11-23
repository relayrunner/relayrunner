import type { RetrySettings } from "@relayrunner/runner-order";
import { api } from "@/lib/api";

const path = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/retry-settings`;

/** The workspace's automatic retries of jobs whose runner failed them. Off until turned on. */
export function getRetrySettings(workspaceId: string): Promise<RetrySettings> {
  return api<RetrySettings>(path(workspaceId));
}

/** Saves the workspace's retries. Owners and admins only. */
export async function setRetrySettings(workspaceId: string, settings: RetrySettings) {
  await api(path(workspaceId), { method: "PUT", body: JSON.stringify(settings) });
}
