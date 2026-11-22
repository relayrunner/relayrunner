import { parseError } from "@relayrunner/errors";
import type { Env } from "./env.ts";

export type Api = <T>(
  path: string,
  query?: Record<string, string | number | undefined>,
) => Promise<T>;

/**
 * Api for one workspace: which of the token's workspaces the request reads. A body is sent as JSON,
 * by POST unless `method` says PUT. A DELETE has no body.
 */
export type WorkspaceApi = <T>(
  path: string,
  options?: {
    query?: Record<string, string | number | undefined>;
    workspaceId?: string;
    body?: unknown;
    method?: "POST" | "PUT" | "DELETE";
  },
) => Promise<T>;

// apps/api/src/agent-auth.ts: AGENT_WORKSPACE_HEADER.
const WORKSPACE_HEADER = "x-relayrunner-workspace";

/**
 * Calls relayrunner-api over the service binding as the agent, with its own access token, about
 * `workspaceId` when given: a GET, or a POST when there's a body, unless `method` says otherwise. The host is a placeholder: the
 * binding ignores it.
 */
export function apiClient(env: Env, token: string): WorkspaceApi {
  return async (path, { query = {}, workspaceId, body, method } = {}) => {
    const url = new URL(`/api${path}`, "https://relayrunner-api");
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (workspaceId) headers[WORKSPACE_HEADER] = workspaceId;
    const verb = method ?? (body === undefined ? undefined : "POST");
    const response = await env.API.fetch(url, {
      ...(verb && { method: verb }),
      ...(body === undefined
        ? { headers }
        : {
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) {
      throw parseError(await response.json().catch(() => null), response.status);
    }
    return response.json();
  };
}

/**
 * GET /api/me for an agent token, the parts this Worker uses: its grant and the workspaces it may
 * read, with whether it may change settings in each.
 */
export interface Me {
  user: { id: string };
  agent: { grantId: string; workspaces: Workspace[] };
}

export interface Workspace {
  id: string;
  name: string;
  canWrite: boolean;
}
