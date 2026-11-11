/**
 * RelayRunner's MCP server, at https://agents.relayrunner.app/mcp. Agents sign in with OAuth
 * against the dashboard (apps/api/src/agent-auth.ts) and get a token for the workspaces they pick,
 * read-only apart from send_feedback (tools.ts).
 * This Worker holds no state and no secrets: it answers each MCP request with a fresh server whose
 * tools call relayrunner-api with the agent's own token, and the API decides what that token sees.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ApiError, apiClient, type Me } from "./api.ts";
import type { Env } from "./env.ts";
import { registerTools } from "./tools.ts";

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(RESOURCE_METADATA_PATH)) return resourceMetadata(env);
    if (url.pathname !== new URL(env.MCP_URL).pathname) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // Stateless: no sessions to resume or end, and no server-initiated stream.
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return unauthorized(env);
    const api = apiClient(env, token);
    let me: Me;
    try {
      me = await api<Me>("/me");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return unauthorized(env, true);
      throw error;
    }
    const { success } = await env.LIMITER.limit({
      key: `${me.user.id}:${me.agent.grantId}`,
    });
    if (!success) return jsonRpcError(429, "Rate limited. Try again in a minute.");

    const server = new McpServer({ name: "relayrunner", version: "0.1.0" });
    registerTools(server, api, me.agent.workspaces);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<Env>;

// RFC 9728: where MCP clients learn which authorization server to sign in with.
function resourceMetadata(env: Env) {
  return Response.json(
    {
      resource: env.MCP_URL,
      authorization_servers: [env.AUTH_ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["workspace:read"],
      resource_name: "RelayRunner",
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}

// A 401 that points MCP clients at the metadata above, so they start (or redo) sign-in.
function unauthorized(env: Env, invalid = false) {
  const metadata = new URL(
    `${RESOURCE_METADATA_PATH}${new URL(env.MCP_URL).pathname}`,
    env.MCP_URL,
  );
  const challenge = [
    `Bearer resource_metadata="${metadata}"`,
    'scope="workspace:read"',
    ...(invalid ? ['error="invalid_token"'] : []),
  ].join(", ");
  return jsonRpcError(401, "Sign in to RelayRunner to use this server.", {
    "www-authenticate": challenge,
  });
}

function jsonRpcError(status: number, message: string, headers: HeadersInit = {}) {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers },
  );
}
