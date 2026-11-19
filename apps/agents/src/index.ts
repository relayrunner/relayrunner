import { AppError } from "@relayrunner/errors";
/**
 * RelayRunner's MCP server, at https://agents.relayrunner.app/mcp. Agents sign in with OAuth
 * against the dashboard (apps/api/src/agent-auth.ts) and get a token for the workspaces they pick.
 * They read (tools.ts), and change routing settings where an owner or admin allows it
 * (write-tools.ts).
 * This Worker holds no state and no secrets: it answers each MCP request with a fresh server whose
 * tools call relayrunner-api with the agent's own token, and the API decides what that token sees.
 * The server also serves the agent skills in skills/ (skills.ts), and speaks both the 2025 protocol
 * revisions and 2026-07-28.
 */
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { tracing } from "cloudflare:workers";
import { apiClient, type Me } from "./api.ts";
import type { Env } from "./env.ts";
import { SERVER_CARD_TYPE, SERVER_VERSION, serverCard } from "./server-card.ts";
import { skillCatalog } from "./skills.ts";
import { registerTools } from "./tools.ts";
import { registerWriteTools } from "./write-tools.ts";

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const mcpPath = new URL(env.MCP_URL).pathname;
    if (url.pathname.startsWith(RESOURCE_METADATA_PATH)) return resourceMetadata(env);
    if (url.pathname === `${mcpPath}/server-card`) return card(request, env);
    if (url.pathname !== mcpPath) return errorResponse(new AppError("NOT_FOUND"));
    // Stateless: no sessions to resume or end, and no server-initiated stream.
    if (request.method !== "POST") {
      return errorResponse(new AppError("METHOD_NOT_ALLOWED"), { allow: "POST" });
    }

    // Built once per isolate; start it while the API checks the token.
    const catalog = skillCatalog();
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return unauthorized(env);
    const api = apiClient(env, token);
    let me: Me;
    try {
      me = await api<Me>("/me");
    } catch (error) {
      if (error instanceof AppError && error.status === 401) return unauthorized(env, true);
      throw error;
    }
    // Ids only, so traces and Workers Issues can be filtered by who made the call.
    tracing.getActiveSpan()?.setAttributes({
      "user.id": me.user.id,
      "relayrunner.agent_grant_id": me.agent.grantId,
    });
    const { success } = await env.LIMITER.limit({
      key: `${me.user.id}:${me.agent.grantId}`,
    });
    if (!success) return jsonRpcError(429, "Rate limited. Try again in a minute.");

    const skills = await catalog;
    const createServer = () => {
      const server = new McpServer(
        { name: "relayrunner", version: SERVER_VERSION },
        { instructions: INSTRUCTIONS },
      );
      registerWriteTools(server, api, registerTools(server, api, me.agent.workspaces));
      skills.attach(server);
      return server;
    };

    // 2025-era clients, which most are today: the same stateless JSON transport as before.
    if (await isLegacyRequest(request)) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await createServer().connect(transport);
      return transport.handleRequest(request);
    }
    return createMcpHandler(createServer, { legacy: "reject" }).fetch(request);
  },
} satisfies ExportedHandler<Env>;

// For clients that read resources but don't load skills themselves.
const INSTRUCTIONS =
  "Read your RelayRunner workspace: runners, workflow runs, routing and CI usage, and change its routing where you're allowed to. For which tool answers which question, read skill://relayrunner-ci-insights/SKILL.md. Before a change, tell the person what you'll change; each change answers the previous value, so you can undo it.";

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

// Public metadata, so any page may read it (the Server Cards extension's CORS rules).
const CARD_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
};

function card(request: Request, env: Env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CARD_CORS });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(new AppError("METHOD_NOT_ALLOWED"), {
      ...CARD_CORS,
      allow: "GET, HEAD, OPTIONS",
    });
  }
  return new Response(JSON.stringify(serverCard(env.MCP_URL)), {
    headers: {
      ...CARD_CORS,
      "content-type": SERVER_CARD_TYPE,
      "cache-control": "public, max-age=3600",
    },
  });
}

// A 401 that points MCP clients at the resource metadata, so they start (or redo) sign-in.
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

function errorResponse(error: AppError, headers?: HeadersInit) {
  return Response.json(error.toJSON(), { status: error.status, headers });
}
