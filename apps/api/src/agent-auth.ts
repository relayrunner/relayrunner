// Agent sign-in for the MCP server (apps/agents). An MCP client signs in with OAuth against this
// Worker's Better Auth (the mcp plugin): the person signs in to the dashboard, picks the workspaces
// the agent may read (/agents/workspace, which writes an agent_grant) and approves the client
// (/agents/consent). The client gets a short-lived access token: a JWT for AGENTS_MCP_URL that names
// the grant and carries the scopes the person approved. The agents Worker forwards it here, with
// the workspace it's asking about in AGENT_WORKSPACE_HEADER, and attachSession
// (middleware/session.ts) turns it into a request for that user, limited to AGENT_ROUTES and to the
// grant's workspaces the user still belongs to.
//
// Phase 1 is read-only: the only scope is workspace:read, and every agent route but one is a GET.
// The exception is POST /api/feedback (routes/feedback.ts): it changes no workspace state, only
// records what the agent reports, rate-limited per user.

import { mcp } from "@better-auth/mcp";
import { APIError } from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { decodeProtectedHeader } from "jose";
import type { Auth, Session } from "./auth.ts";
import { createDb, schema, type Db } from "./db/index.ts";
import type { Env } from "./env.ts";
import { and, desc, eq, gt } from "drizzle-orm";

const AGENT_READ_SCOPE = "workspace:read";
// The grant a token is for: the consent's reference id, copied into the access token.
const GRANT_CLAIM = "grant_id";
// Which of its workspaces an agent request reads. Optional when the grant has only one.
export const AGENT_WORKSPACE_HEADER = "x-relayrunner-workspace";
// How long after the picker consent may still pick up its grant.
const PENDING_GRANT_MS = 30 * 60 * 1000;

// Dashboard pages in the sign-in flow (apps/web/src/routes/agents.*.tsx, login.tsx).
export const AGENT_WORKSPACE_PAGE = "/agents/workspace";
export const AGENT_CONSENT_PAGE = "/agents/consent";

/**
 * The OAuth provider for agents. Clients register themselves (dynamic client registration, which
 * MCP clients use), and every authorization runs through the workspace picker before consent, so
 * consent and tokens are always tied to a grant of workspaces the person belongs to.
 */
export function agentOAuth(env: Env) {
  const db = () => createDb(env.DB);
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
      // Always ask which workspaces on the way in; on the way back, only continue once the picker
      // has written a grant for this session.
      shouldRedirect: async ({ session, user, isContinuation }) =>
        !isContinuation || !(await pendingGrant(db(), session.id, user.id)),
      consentReferenceId: async ({ session, user }) => {
        const grantId = await pendingGrant(db(), session.id, user.id);
        if (!grantId) throw new APIError("BAD_REQUEST", { error: "no_agent_grant" });
        return grantId;
      },
    },
    // Runs on every issue and refresh: someone removed from every granted workspace (or
    // disconnected from all of them) stops getting tokens.
    customAccessTokenClaims: async ({ user, referenceId }) => {
      if (!user || !referenceId) return {};
      if ((await grantedWorkspaces(db(), referenceId, user.id)).length === 0) {
        throw new APIError("FORBIDDEN", { error: "not_a_member" });
      }
      return { [GRANT_CLAIM]: referenceId };
    },
  });
}

/** The grant the workspace picker last wrote for this session, while consent may still use it. */
export async function pendingGrant(db: Db, sessionId: unknown, userId: string) {
  if (typeof sessionId !== "string") return null;
  const [grant] = await db
    .select({ id: schema.agentGrant.id })
    .from(schema.agentGrant)
    .where(
      and(
        eq(schema.agentGrant.sessionId, sessionId),
        eq(schema.agentGrant.userId, userId),
        gt(schema.agentGrant.createdAt, new Date(Date.now() - PENDING_GRANT_MS)),
      ),
    )
    .orderBy(desc(schema.agentGrant.createdAt))
    .limit(1);
  return grant?.id ?? null;
}

/** The workspaces a grant still covers that its user still belongs to. */
async function grantedWorkspaces(db: Db, grantId: string, userId: string) {
  return db
    .select({ id: schema.workspace.id, name: schema.workspace.name })
    .from(schema.agentGrantWorkspace)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.agentGrantWorkspace.workspaceId))
    .innerJoin(schema.agentGrant, eq(schema.agentGrant.id, schema.agentGrantWorkspace.grantId))
    .innerJoin(
      schema.workspaceMember,
      and(
        eq(schema.workspaceMember.workspaceId, schema.agentGrantWorkspace.workspaceId),
        eq(schema.workspaceMember.userId, userId),
      ),
    )
    .where(and(eq(schema.agentGrant.id, grantId), eq(schema.agentGrant.userId, userId)))
    .orderBy(schema.workspace.name);
}

/** Who an agent request acts for, from its verified access token: its grant and the workspaces it may read. */
export interface AgentPrincipal {
  grantId: string;
  // The OAuth client (the agent app) the token was issued to.
  clientId: string;
  workspaces: { id: string; name: string }[];
}

/**
 * The workspace an agent request reads: the one AGENT_WORKSPACE_HEADER names if the grant covers
 * it, else the grant's only one. Null when it names another or has several and names none.
 */
export function agentWorkspaceId(agent: AgentPrincipal, requested: string | undefined) {
  const id = requested ?? (agent.workspaces.length === 1 ? agent.workspaces[0].id : undefined);
  return agent.workspaces.some((workspace) => workspace.id === id) ? id! : null;
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
 * Verifies an agent access token and loads its user and workspaces. Null when the token is bad,
 * expired, for another audience, lacks the read scope, or leaves no workspace the user still
 * belongs to. requireWorkspace picks the request's workspace from these (agentWorkspaceId).
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
  if (!scopes.includes(AGENT_READ_SCOPE)) return null;
  const db = createDb(env.DB);
  const grantId = claims[GRANT_CLAIM];
  if (typeof grantId !== "string") return null;
  // Read live, so disconnecting a workspace in Settings takes effect on the next request.
  const [workspaces, [user]] = await Promise.all([
    grantedWorkspaces(db, grantId, claims.sub!),
    db.select().from(schema.user).where(eq(schema.user.id, claims.sub!)).limit(1),
  ]);
  if (workspaces.length === 0 || !user) return null;
  return {
    user: user as Session["user"],
    agent: { grantId, clientId: String(claims.azp), workspaces } satisfies AgentPrincipal,
  };
}

// The issuer Better Auth stamps on access tokens: its auth base URL.
export function agentIssuer(env: Env) {
  return new URL("/api/auth", env.BETTER_AUTH_URL).toString();
}

// What an agent token may call: read-only views of its own workspace, all D1 reads. Nothing that
// asks GitHub per request, takes the Router's lock, or changes anything. Routes with a workspace id
// in the path only accept the token's workspaces (requireMember in routes/workspaces.ts).
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

// The one write: agent feedback, which only adds a row for its own user (routes/feedback.ts).
const AGENT_WRITE_ROUTES: RegExp[] = [/^\/api\/feedback$/];

export function agentMayCall(method: string, pathname: string) {
  const routes =
    method === "GET" || method === "HEAD"
      ? AGENT_ROUTES
      : method === "POST"
        ? AGENT_WRITE_ROUTES
        : [];
  return routes.some((route) => route.test(pathname));
}
