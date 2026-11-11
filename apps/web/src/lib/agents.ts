import { api } from "@/lib/api";

/** An MCP client the signed-in user connected to the active workspace (GET /api/agents). */
export type ConnectedAgent = {
  id: string;
  clientName: string | null;
  clientUri: string | null;
  connectedAt: string;
};

export function listAgents() {
  // mcpUrl: the MCP server agents connect to (apps/agents).
  return api<{ mcpUrl: string; agents: ConnectedAgent[] }>("/agents");
}

export function disconnectAgent(id: string) {
  return api<{ ok: true }>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}
