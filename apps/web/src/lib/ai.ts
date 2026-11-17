import { api } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";

const path = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/ai`;

/** When the workspace opted in to AI, or null. */
export async function getAiOptIn(workspaceId: string): Promise<string | null> {
  // The dev preview has no API behind it.
  if (authDisabled) return null;
  return (await api<{ since: string | null }>(path(workspaceId))).since;
}

/** Opts the workspace in or out. Owners and admins only. */
export async function setAiOptIn(workspaceId: string, enabled: boolean) {
  if (authDisabled) return;
  await api(path(workspaceId), { method: "PUT", body: JSON.stringify({ enabled }) });
}
