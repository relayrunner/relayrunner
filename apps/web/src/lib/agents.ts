import { api } from "@/lib/api";

/** An MCP client the signed-in user connected to the active workspace (GET /api/agents). */
export type ConnectedAgent = {
  id: string;
  clientName: string | null;
  clientUri: string | null;
  scopes: string[];
  connectedAt: string;
};

/** The MCP server agents connect to (apps/agents). */
export const MCP_URL = "https://agents.relayrunner.app/mcp";

export function listAgents() {
  return api<{ agents: ConnectedAgent[] }>("/agents");
}

export function disconnectAgent(id: string) {
  return api<{ ok: true }>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}
