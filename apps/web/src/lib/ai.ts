import { api } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";

const path = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/ai`;

/** When the workspace turned off AI, or null while it's on (the default). */
export async function getAiOffAt(workspaceId: string): Promise<string | null> {
  // The dev preview has no API behind it.
  if (authDisabled) return null;
  return (await api<{ offAt: string | null }>(path(workspaceId))).offAt;
}

/** Turns AI on or off for the workspace. Owners and admins only. */
export async function setWorkspaceAi(workspaceId: string, enabled: boolean) {
  if (authDisabled) return;
  await api(path(workspaceId), { method: "PUT", body: JSON.stringify({ enabled }) });
}
