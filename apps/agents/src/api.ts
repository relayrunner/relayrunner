import type { Env } from "./env.ts";

/** A non-2xx answer from relayrunner-api. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`RelayRunner API answered ${status}${code ? ` (${code})` : ""}`);
  }
}

export type Api = <T>(
  path: string,
  query?: Record<string, string | number | undefined>,
) => Promise<T>;

/** Api for one workspace: which of the token's workspaces the request reads. */
export type WorkspaceApi = <T>(
  path: string,
  query?: Record<string, string | number | undefined>,
  workspaceId?: string,
) => Promise<T>;

// apps/api/src/agent-auth.ts: AGENT_WORKSPACE_HEADER.
const WORKSPACE_HEADER = "x-relayrunner-workspace";

/**
 * GETs relayrunner-api over the service binding as the agent, with its own access token, about
 * `workspaceId` when given. The host is a placeholder: the binding ignores it.
 */
export function apiClient(env: Env, token: string): WorkspaceApi {
  return async (path, query = {}, workspaceId) => {
    const url = new URL(`/api${path}`, "https://relayrunner-api");
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (workspaceId) headers[WORKSPACE_HEADER] = workspaceId;
    const response = await env.API.fetch(url, { headers });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(response.status, body?.error);
    }
    return response.json();
  };
}

/** GET /api/me for an agent token, the parts this Worker uses: its grant and the workspaces it may read. */
export interface Me {
  user: { id: string };
  agent: { grantId: string; workspaces: Workspace[] };
}

export interface Workspace {
  id: string;
  name: string;
}
