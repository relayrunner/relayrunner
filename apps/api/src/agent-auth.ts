// Agent sign-in for the MCP server (apps/agents). An MCP client signs in with OAuth against this
// Worker's Better Auth (the mcp plugin): the person signs in to the dashboard, picks one workspace
// (/agents/workspace) and approves the client (/agents/consent). The client gets a short-lived
// access token: a JWT for AGENTS_MCP_URL that names that one workspace and carries the scopes the
// person approved. The agents Worker forwards it here, and attachSession (middleware/session.ts)
// turns it into a request for that user in that workspace, limited to AGENT_ROUTES.
//
// Phase 1 is read-only: the only scope is workspace:read, and every agent route is a GET.

import { mcp } from "@better-auth/mcp";
import { APIError } from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { decodeProtectedHeader } from "jose";
import type { Auth, Session } from "./auth.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { isWorkspaceMember } from "./installations.ts";
import { eq } from "drizzle-orm";

const AGENT_READ_SCOPE = "workspace:read";
// The workspace a token is for: the consent's reference id, copied into the access token.
const WORKSPACE_CLAIM = "workspace_id";

// Dashboard pages in the sign-in flow (apps/web/src/routes/agents.*.tsx, login.tsx).
export const AGENT_WORKSPACE_PAGE = "/agents/workspace";
export const AGENT_CONSENT_PAGE = "/agents/consent";

/**
 * The OAuth provider for agents. Clients register themselves (dynamic client registration, which
 * MCP clients use), and every authorization runs through the workspace picker before consent, so
 * consent and tokens are always tied to one workspace the person belongs to.
 */
export function agentOAuth(env: Env) {
  const db = () => createDb(env.DB);
  // The session's active workspace, if the user is still a member of it.
  const memberWorkspace = async (session: Record<string, unknown>, userId: string) => {
    const workspaceId = session.activeOrganizationId;
    if (typeof workspaceId !== "string") return null;
    return (await isWorkspaceMember(db(), workspaceId, userId)) ? workspaceId : null;
  };
  return mcp({
    resource: env.AGENTS_MCP_URL,
    loginPage: "/login",
    consentPage: AGENT_CONSENT_PAGE,
    scopes: ["openid", "profile", "email", "offline_access", AGENT_READ_SCOPE],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Access tokens can't be revoked once issued, so keep them short; refresh re-checks membership.
    accessTokenExpiresIn: 15 * 60,
    postLogin: {
      page: AGENT_WORKSPACE_PAGE,
      // Always ask which workspace on the way in; on the way back, only continue once the session
      // points at a workspace the user is in.
      shouldRedirect: async ({ session, user, isContinuation }) =>
        !isContinuation || !(await memberWorkspace(session, user.id)),
      consentReferenceId: async ({ session, user }) => {
        const workspaceId = await memberWorkspace(session, user.id);
        if (!workspaceId) throw new APIError("BAD_REQUEST", { error: "no_active_workspace" });
        return workspaceId;
      },
    },
    // Runs on every issue and refresh: someone removed from the workspace stops getting tokens.
    customAccessTokenClaims: async ({ user, referenceId }) => {
      if (!user || !referenceId) return {};
      if (!(await isWorkspaceMember(db(), referenceId, user.id))) {
        throw new APIError("FORBIDDEN", { error: "not_a_member" });
      }
      return { [WORKSPACE_CLAIM]: referenceId };
    },
  });
}

/** Who an agent request acts for, from its verified access token: the one workspace it may read. */
export interface AgentPrincipal {
  workspaceId: string;
}

// Keeps verified signing keys per isolate (5 minutes, refetched on an unknown key id) instead of
// reading the jwks table on every agent request.
const JWKS_CACHE_KEY = {};

// An OAuth access token, as opposed to a Better Auth session token (bearer plugin), which is opaque.
export function agentBearer(headers: Headers) {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
  if (!match) return null;
  try {
    return decodeProtectedHeader(match[1]).typ === "at+jwt" ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Verifies an agent access token and loads its user and workspace. Null when the token is bad,
 * expired, for another audience, lacks the read scope or names no workspace. requireWorkspace
 * takes the workspace from here and still checks membership on every request.
 */
export async function agentSession(env: Env, auth: Auth, token: string) {
  let claims;
  try {
    claims = await verifyJwsAccessToken(token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: JWKS_CACHE_KEY,
      verifyOptions: {
        issuer: agentIssuer(env),
        audience: env.AGENTS_MCP_URL,
        typ: "at+jwt",
        requiredClaims: ["azp", "sub"],
      },
    });
  } catch {
    return null;
  }
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  const workspaceId = claims[WORKSPACE_CLAIM];
  if (!scopes.includes(AGENT_READ_SCOPE) || typeof workspaceId !== "string") return null;

  const [user] = await createDb(env.DB)
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, claims.sub!))
    .limit(1);
  if (!user) return null;
  return { user: user as Session["user"], agent: { workspaceId } satisfies AgentPrincipal };
}

// The issuer Better Auth stamps on access tokens: its auth base URL.
export function agentIssuer(env: Env) {
  return new URL("/api/auth", env.BETTER_AUTH_URL).toString();
}

// What an agent token may call: read-only views of its own workspace, all D1 reads. Nothing that
// asks GitHub per request, takes the Router's lock, or changes anything. Routes with a workspace id
// in the path only accept the token's workspace (requireMember in routes/workspaces.ts).
const AGENT_ROUTES: RegExp[] = [
  /^\/api\/me$/,
  /^\/api\/workspaces\/current$/,
  /^\/api\/workspaces\/[^/]+\/runner-order$/,
  /^\/api\/machines$/,
  /^\/api\/runs$/,
  /^\/api\/runs\/\d+\/\d+\/\d+\/jobs$/,
  /^\/api\/activity$/,
  /^\/api\/usage$/,
  /^\/api\/usage\/(checks|actions)$/,
  /^\/api\/job-times$/,
];

export function agentMayCall(method: string, pathname: string) {
  return (
    (method === "GET" || method === "HEAD") && AGENT_ROUTES.some((route) => route.test(pathname))
  );
}
