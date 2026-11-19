import { api } from "@/lib/api";

/** An MCP client the signed-in user connected to the active workspace (GET /api/agents). */
export type ConnectedAgent = {
  id: string;
  clientName: string | null;
  clientUri: string | null;
  connectedAt: string;
  // Whether it may change settings in this workspace (Allow changes).
  canWrite: boolean;
};

export function listAgents() {
  // mcpUrl: the MCP server agents connect to (apps/agents).
  // canManage: whether the signed-in user may allow changes (owners and admins).
  return api<{ mcpUrl: string; canManage: boolean; agents: ConnectedAgent[] }>("/agents");
}

/** Allow changes: lets the agent change routing settings in the active workspace, or stops it. */
export function setAgentChanges(id: string, enabled: boolean) {
  return api<{ canWrite: boolean }>(`/agents/${encodeURIComponent(id)}/changes`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function disconnectAgent(id: string) {
  return api<{ ok: true }>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Agent sign-in: the workspaces the person picked for the agent, before consent. */
export function grantAgentWorkspaces(workspaceIds: string[]) {
  return api<{ id: string }>("/agents/grants", {
    method: "POST",
    body: JSON.stringify({ workspaceIds }),
  });
}

/** Agent sign-in: the workspaces just picked, for the consent page to name. */
export function pendingAgentWorkspaces() {
  return api<{ workspaces: { id: string; name: string }[] }>("/agents/grants/pending");
}
