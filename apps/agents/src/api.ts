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

/** Api for one workspace: which of the token's workspaces the request reads. A body POSTs it as JSON. */
export type WorkspaceApi = <T>(
  path: string,
  options?: {
    query?: Record<string, string | number | undefined>;
    workspaceId?: string;
    body?: unknown;
  },
) => Promise<T>;

// apps/api/src/agent-auth.ts: AGENT_WORKSPACE_HEADER.
const WORKSPACE_HEADER = "x-relayrunner-workspace";

/**
 * Calls relayrunner-api over the service binding as the agent, with its own access token, about
 * `workspaceId` when given: a GET, or a POST when there's a body. The host is a placeholder: the
 * binding ignores it.
 */
export function apiClient(env: Env, token: string): WorkspaceApi {
  return async (path, { query = {}, workspaceId, body } = {}) => {
    const url = new URL(`/api${path}`, "https://relayrunner-api");
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (workspaceId) headers[WORKSPACE_HEADER] = workspaceId;
    const response = await env.API.fetch(
      url,
      body === undefined
        ? { headers }
        : {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
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
