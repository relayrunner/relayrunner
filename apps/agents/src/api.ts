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

/**
 * GETs relayrunner-api over the service binding as the agent, with its own access token. The host
 * is a placeholder: the binding ignores it.
 */
export function apiClient(env: Env, token: string): Api {
  return async (path, query = {}) => {
    const url = new URL(`/api${path}`, "https://relayrunner-api");
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await env.API.fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(response.status, body?.error);
    }
    return response.json();
  };
}

/** GET /api/me for an agent token, the parts this Worker uses. */
export interface Me {
  user: { id: string };
  agent: { workspaceId: string };
}
