import { type RetrySettings } from "@relayrunner/runner-order";
import { api } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";

const path = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/retry-settings`;

/** The workspace's automatic retries of jobs whose runner failed them. Off until turned on. */
export function getRetrySettings(workspaceId: string): Promise<RetrySettings> {
  // The dev preview has no API behind it.
  return api<RetrySettings>(path(workspaceId));
}

/** Saves the workspace's retries. Owners and admins only. */
export async function setRetrySettings(workspaceId: string, settings: RetrySettings) {
  if (authDisabled) return;
  await api(path(workspaceId), { method: "PUT", body: JSON.stringify(settings) });
}
