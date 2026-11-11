import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AGENT_CONSENT_PAGE, AGENT_WORKSPACE_PAGE, agentIssuer } from "./agent-auth.ts";
import { app } from "./app.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";
import { wellKnown } from "./well-known.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

const REDIRECT_URI = "https://agent.example.com/callback";

function base64url(bytes: ArrayBuffer | Uint8Array) {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    "base64url",
  );
}

function post(path: string, body: unknown, cookie?: string) {
  return app.request(
    `/api${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: env.BETTER_AUTH_URL,
        ...(cookie && { cookie }),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

function asAgent(path: string, token: string, init: RequestInit = {}) {
  return app.request(
    `/api${path}`,
    { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } },
    env,
  );
}

// The signed query Better Auth hands each sign-in page, from the page URL it redirects to.
function oauthQuery(url: string) {
  return new URL(url, env.BETTER_AUTH_URL).search.slice(1);
}

// What an MCP client and the dashboard do together: register, authorize, pick the workspace on
// /agents/workspace, approve on /agents/consent, then trade the code for tokens.
async function signInAgent(cookie: string, scope = "workspace:read offline_access") {
  const registered = await post("/auth/oauth2/register", {
    client_name: "Test agent",
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT_URI,
    scope,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: env.AGENTS_MCP_URL,
  });
  const authorized = await app.request(
    `/api/auth/oauth2/authorize?${authorize}`,
    { headers: { cookie } },
    env,
  );
  expect(authorized.status, await authorized.clone().text()).toBe(302);
  const workspacePage = authorized.headers.get("location")!;
  expect(new URL(workspacePage, env.BETTER_AUTH_URL).pathname).toBe(AGENT_WORKSPACE_PAGE);

  const continued = await post(
    "/auth/oauth2/continue",
    { postLogin: true, oauth_query: oauthQuery(workspacePage) },
    cookie,
  );
  expect(continued.status, await continued.clone().text()).toBe(200);
  const consentPage = ((await continued.json()) as { url: string }).url;
  expect(new URL(consentPage, env.BETTER_AUTH_URL).pathname).toBe(AGENT_CONSENT_PAGE);

  const consented = await post(
    "/auth/oauth2/consent",
    { accept: true, oauth_query: oauthQuery(consentPage) },
    cookie,
  );
  expect(consented.status, await consented.clone().text()).toBe(200);
  const callback = new URL(((await consented.json()) as { url: string }).url);
  expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
  const code = callback.searchParams.get("code")!;

  const tokens = await app.request(
    "/api/auth/oauth2/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id,
        code_verifier: verifier,
        resource: env.AGENTS_MCP_URL,
      }),
    },
    env,
  );
  expect(tokens.status, await tokens.clone().text()).toBe(200);
  const body = (await tokens.json()) as { access_token: string; refresh_token: string };
  return { ...body, client_id };
}

function refresh(client_id: string, refresh_token: string) {
  return app.request(
    "/api/auth/oauth2/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id,
        resource: env.AGENTS_MCP_URL,
      }),
    },
    env,
  );
}

describe("agent sign-in", () => {
  test("an agent token reads its own workspace and nothing else", async () => {
    const { user, cookie } = await testing.signIn(env);
    const { workspace, cookie: jar } = await testing.createWorkspace(
      env,
      cookie,
      "Agents",
      "agents",
    );
    const { access_token } = await signInAgent(jar);

    const me = await asAgent("/me", access_token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { id: user.id },
      agent: { workspaceId: workspace.id, scopes: expect.arrayContaining(["workspace:read"]) },
    });

    for (const path of [
      "/workspaces/current",
      `/workspaces/${workspace.id}/runner-order`,
      "/machines",
      "/runs",
      "/activity",
      "/usage",
      "/usage/actions",
    ]) {
      const response = await asAgent(path, access_token);
      expect(response.status, path).toBe(200);
    }
    const current = (await (await asAgent("/workspaces/current", access_token)).json()) as {
      workspace: { id: string };
    };
    expect(current.workspace.id).toBe(workspace.id);

    // Writes, other workspaces and routes outside the read-only list are refused.
    const order = await asAgent(`/workspaces/${workspace.id}/runner-order`, access_token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ key: "github" }] }),
    });
    expect(order.status).toBe(403);
    const { workspace: other, cookie: otherJar } = await testing.createWorkspace(
      env,
      jar,
      "Other",
      "agents-other",
    );
    expect(otherJar).toBeTruthy();
    expect((await asAgent(`/workspaces/${other.id}/runner-order`, access_token)).status).toBe(403);
    expect((await asAgent("/github/installations/unclaimed", access_token)).status).toBe(403);
    expect((await asAgent("/auth/get-session", access_token)).status).toBe(403);

    // The token still reads the workspace it was granted, not the session's new active one.
    const after = (await (await asAgent("/workspaces/current", access_token)).json()) as {
      workspace: { id: string };
    };
    expect(after.workspace.id).toBe(workspace.id);
  });

  test("a tampered or foreign token is rejected", async () => {
    const { cookie } = await testing.signIn(env);
    const { cookie: jar } = await testing.createWorkspace(env, cookie, "Tamper", "agents-tamper");
    const { access_token } = await signInAgent(jar);
    const [header, payload, signature] = access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forged = [
      header,
      Buffer.from(JSON.stringify({ ...claims, workspace_id: "someone-else" })).toString(
        "base64url",
      ),
      signature,
    ].join(".");
    expect((await asAgent("/me", forged)).status).toBe(401);
  });

  test("removing the member cuts the agent off, refresh included", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Removal", "agents-removal");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const { access_token, refresh_token, client_id } = await signInAgent(member.cookie);
    expect((await asAgent("/workspaces/current", access_token)).status).toBe(200);

    await env.DB.prepare("delete from workspace_member where user_id = ?")
      .bind(member.user.id)
      .run();
    expect((await asAgent("/workspaces/current", access_token)).status).toBe(409);
    expect((await refresh(client_id, refresh_token)).status).not.toBe(200);
  });

  test("Settings lists the connected agent, and disconnecting revokes its refresh token", async () => {
    const { cookie } = await testing.signIn(env);
    const { cookie: jar } = await testing.createWorkspace(env, cookie, "Settings", "agents-list");
    const { refresh_token, client_id } = await signInAgent(jar);

    const listed = (await (await testing.call(env, "/agents", jar)).json()) as {
      agents: { id: string; clientName: string }[];
    };
    expect(listed.agents).toEqual([expect.objectContaining({ clientName: "Test agent" })]);
    // An agent token can't see or change these.
    const refreshed = await refresh(client_id, refresh_token);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect((await asAgent("/agents", next.access_token)).status).toBe(403);

    const removed = await app.request(
      `/api/agents/${listed.agents[0].id}`,
      { method: "DELETE", headers: { cookie: jar, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(removed.status).toBe(200);
    expect((await refresh(client_id, next.refresh_token)).status).not.toBe(200);
    const after = (await (await testing.call(env, "/agents", jar)).json()) as { agents: [] };
    expect(after.agents).toEqual([]);
  });

  test("discovery metadata names the dashboard's auth server", async () => {
    const response = await wellKnown(
      new Request(`${env.BETTER_AUTH_URL}/.well-known/oauth-authorization-server/api/auth`),
      env,
    );
    expect(response?.status).toBe(200);
    const metadata = (await response!.json()) as { issuer: string; registration_endpoint: string };
    expect(metadata.issuer).toBe(agentIssuer(env));
    expect(metadata.registration_endpoint).toBe(`${agentIssuer(env)}/oauth2/register`);
    expect(wellKnown(new Request(`${env.BETTER_AUTH_URL}/api/health`), env)).toBeNull();
  });
});
