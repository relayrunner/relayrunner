import { beforeAll, describe, expect, test, vi } from "vitest";
import { AGENT_CONSENT_PAGE, AGENT_WORKSPACE_PAGE, agentIssuer } from "./agent-auth.ts";
import { app } from "./app.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";
import { wellKnown } from "./well-known.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
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

function asAgent(path: string, token: string, init: RequestInit = {}, workspace?: string) {
  return app.request(
    `/api${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(workspace && { "x-relayrunner-workspace": workspace }),
        ...init.headers,
      },
    },
    env,
  );
}

// The session's active workspace, which the picker checks by default.
async function activeWorkspace(cookie: string) {
  const current = await testing.call(env, "/workspaces/current", cookie);
  return ((await current.json()) as { workspace: { id: string } }).workspace.id;
}

// The signed query Better Auth hands each sign-in page, from the page URL it redirects to.
function oauthQuery(url: string) {
  return new URL(url, env.BETTER_AUTH_URL).search.slice(1);
}

// What an MCP client and the dashboard do together: register, authorize, pick the workspaces on
// /agents/workspace (the active one unless given), approve on /agents/consent, then trade the code
// for tokens.
async function signInAgent(
  cookie: string,
  {
    workspaceIds,
    scope = "workspace:read offline_access",
  }: { workspaceIds?: string[]; scope?: string } = {},
) {
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

  // Continuing before picking sends the browser back to the picker.
  const early = await post(
    "/auth/oauth2/continue",
    { postLogin: true, oauth_query: oauthQuery(workspacePage) },
    cookie,
  );
  expect(new URL(((await early.json()) as { url: string }).url, env.BETTER_AUTH_URL).pathname).toBe(
    AGENT_WORKSPACE_PAGE,
  );
  const granted = await testing.call(env, "/agents/grants", cookie, {
    workspaceIds: workspaceIds ?? [await activeWorkspace(cookie)],
  });
  expect(granted.status, await granted.clone().text()).toBe(201);

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
      agent: { workspaces: [{ id: workspace.id, name: "Agents" }] },
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
    expect((await asAgent(`/workspaces/${other.id}/runner-order`, access_token)).status).toBe(404);
    expect((await asAgent("/github/installations/unclaimed", access_token)).status).toBe(403);
    expect((await asAgent("/auth/get-session", access_token)).status).toBe(403);

    // The token still reads the workspace it was granted, not the session's new active one.
    const after = (await (await asAgent("/workspaces/current", access_token)).json()) as {
      workspace: { id: string };
    };
    expect(after.workspace.id).toBe(workspace.id);
  });

  test("agent tokens are rate limited per user and grant, wherever they're sent from", async () => {
    const { user, cookie } = await testing.signIn(env);
    const { cookie: jar } = await testing.createWorkspace(env, cookie, "Limited", "agents-limit");
    const { access_token } = await signInAgent(jar);
    const keys: string[] = [];
    env.AGENT_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.length <= 2 };
      },
    };
    try {
      expect((await asAgent("/me", access_token)).status).toBe(200);
      expect((await asAgent("/machines", access_token)).status).toBe(200);
      const limited = await asAgent("/runs", access_token);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(await limited.json()).toEqual({ error: "rate_limited" });
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(new RegExp(`^${user.id}:`));
    } finally {
      delete env.AGENT_LIMITER;
    }
  });

  test("one token reads each workspace it was granted, one at a time", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace: first, cookie: jar } = await testing.createWorkspace(
      env,
      cookie,
      "First",
      "agents-multi-1",
    );
    const { workspace: second, cookie: jar2 } = await testing.createWorkspace(
      env,
      jar,
      "Second",
      "agents-multi-2",
    );
    const { workspace: third, cookie: jar3 } = await testing.createWorkspace(
      env,
      jar2,
      "Third",
      "agents-multi-3",
    );
    const { access_token, refresh_token, client_id } = await signInAgent(jar3, {
      workspaceIds: [first.id, second.id],
    });

    // What the consent page named.
    const pending = (await (await testing.call(env, "/agents/grants/pending", jar3)).json()) as {
      workspaces: { name: string }[];
    };
    expect(pending.workspaces.map((workspace) => workspace.name)).toEqual(["First", "Second"]);

    const me = (await (await asAgent("/me", access_token)).json()) as {
      agent: { workspaces: { id: string; name: string }[] };
    };
    expect(me.agent.workspaces).toEqual([
      { id: first.id, name: "First" },
      { id: second.id, name: "Second" },
    ]);

    // With two workspaces, a request has to say which.
    const unsaid = await asAgent("/workspaces/current", access_token);
    expect(unsaid.status).toBe(409);
    expect(await unsaid.json()).toEqual({ error: "workspace_required" });
    for (const workspace of [first, second]) {
      const current = await asAgent("/workspaces/current", access_token, {}, workspace.id);
      expect(current.status).toBe(200);
      expect(((await current.json()) as { workspace: { id: string } }).workspace.id).toBe(
        workspace.id,
      );
      const order = await asAgent(`/workspaces/${workspace.id}/runner-order`, access_token);
      expect(order.status).toBe(200);
    }
    // The workspace it wasn't granted stays out of reach, by header or by path.
    expect((await asAgent("/workspaces/current", access_token, {}, third.id)).status).toBe(409);
    expect((await asAgent(`/workspaces/${third.id}/runner-order`, access_token)).status).toBe(404);

    // Disconnecting it from one workspace drops that one at once and keeps the other.
    const listed = (await (await testing.call(env, "/agents", jar3)).json()) as {
      agents: { id: string }[];
    };
    expect(listed.agents).toEqual([]);
    const switched = await testing.call(env, "/auth/organization/set-active", jar3, {
      organizationId: first.id,
    });
    const inFirstJar = testing.withSetCookies(jar3, switched);
    const inFirst = (await (await testing.call(env, "/agents", inFirstJar)).json()) as {
      agents: { id: string }[];
    };
    expect(inFirst.agents).toHaveLength(1);
    const removed = await app.request(
      `/api/agents/${inFirst.agents[0].id}`,
      { method: "DELETE", headers: { cookie: inFirstJar, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(removed.status).toBe(200);
    expect((await asAgent("/workspaces/current", access_token, {}, first.id)).status).toBe(409);
    const only = await asAgent("/workspaces/current", access_token);
    expect(((await only.json()) as { workspace: { id: string } }).workspace.id).toBe(second.id);
    // The client can still refresh for the workspace it kept.
    expect((await refresh(client_id, refresh_token)).status).toBe(200);
  });

  test("the picker only grants workspaces the person belongs to", async () => {
    const { cookie } = await testing.signIn(env);
    const { cookie: jar } = await testing.createWorkspace(env, cookie, "Mine", "agents-mine");
    const outsider = await testing.signIn(env);
    const { workspace: theirs } = await testing.createWorkspace(
      env,
      outsider.cookie,
      "Theirs",
      "agents-theirs",
    );
    const granted = await testing.call(env, "/agents/grants", jar, {
      workspaceIds: [await activeWorkspace(jar), theirs.id],
    });
    expect(granted.status).toBe(404);
  });

  test("a tampered or foreign token is rejected", async () => {
    const { cookie } = await testing.signIn(env);
    const { cookie: jar } = await testing.createWorkspace(env, cookie, "Tamper", "agents-tamper");
    const { access_token } = await signInAgent(jar);
    const [header, payload, signature] = access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forged = [
      header,
      Buffer.from(JSON.stringify({ ...claims, grant_id: "someone-else" })).toString("base64url"),
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
    // A token left with no workspace it can read is no longer a valid token.
    expect((await asAgent("/workspaces/current", access_token)).status).toBe(401);
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

describe("agent feedback", () => {
  function sendFeedback(
    token: string,
    body: unknown,
    init: { env?: Env; workspace?: string } = {},
  ) {
    return app.request(
      "/api/feedback",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.workspace && { "x-relayrunner-workspace": init.workspace }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      init.env ?? env,
    );
  }

  test("stores sanitized feedback, emails it, and never echoes it back", async () => {
    const { user, cookie } = await testing.signIn(env);
    const { workspace, cookie: jar } = await testing.createWorkspace(
      env,
      cookie,
      "Feedback",
      "agents-feedback",
    );
    const { access_token, client_id } = await signInAgent(jar);
    const send = vi.fn(async () => ({ messageId: "m1" }));
    const withEmail = { ...env, EMAIL: { send } as unknown as SendEmail };

    const response = await sendFeedback(
      access_token,
      {
        category: "bug",
        summary: "list_runs\u202e drops\nqueued runs",
        details: "Called with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\u0000 and got []",
        tool: "list_runs<script>",
      },
      { env: withEmail, workspace: workspace.id },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { id: string; redacted: number };
    expect(body).toEqual({ id: expect.any(String), redacted: 1 });
    expect(JSON.stringify(body)).not.toContain("ghp_");

    const row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
      .bind(body.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      user_id: user.id,
      workspace_id: workspace.id,
      client_id,
      source: "agent",
      category: "bug",
      summary: "list_runs drops queued runs",
      details: "Called with token=[redacted] and got []",
      tool: "list_runsscript",
    });

    expect(send).toHaveBeenCalledOnce();
    const message = (send.mock.calls[0] as unknown[])[0] as {
      to: string;
      replyTo: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(message.to).toBe("feedback@relayrunner.app");
    expect(message.replyTo).toBe(user.email);
    expect(message.subject).toBe("[feedback] bug: list_runs drops queued runs");
    expect(message.text).toContain("Agent: Test agent");
    expect(message.text).toContain("Workspace: Feedback");
    expect(message.text).not.toContain("ghp_");
    expect(message.html).not.toContain("<script>");
  });

  test("refuses bad input, other workspaces, sessions, and floods", async () => {
    const { cookie } = await testing.signIn(env);
    const { cookie: jar } = await testing.createWorkspace(env, cookie, "Flood", "agents-flood");
    const { access_token } = await signInAgent(jar);
    const noEmail = { ...env, FEEDBACK_EMAIL: undefined };

    expect((await sendFeedback(access_token, { category: "nope", summary: "x" })).status).toBe(400);
    expect(
      (await sendFeedback(access_token, { category: "bug", summary: " \u200b " })).status,
    ).toBe(400);
    expect(
      (await sendFeedback(access_token, { category: "bug", summary: "x".repeat(400) })).status,
    ).toBe(400);
    expect(
      (
        await sendFeedback(
          access_token,
          JSON.stringify({ category: "bug", summary: "x", details: "y".repeat(20_000) }),
        )
      ).status,
    ).toBe(413);
    expect(
      (await sendFeedback(access_token, { category: "bug", summary: "x" }, { workspace: "other" }))
        .status,
    ).toBe(404);
    // A dashboard session sends a message, not an agent's report.
    expect(
      (await testing.call(env, "/feedback", jar, { category: "bug", summary: "x" })).status,
    ).toBe(400);

    for (let i = 0; i < 10; i++) {
      const ok = await sendFeedback(
        access_token,
        { category: "other", summary: `note ${i}` },
        {
          env: noEmail,
        },
      );
      expect(ok.status).toBe(201);
    }
    const limited = await sendFeedback(
      access_token,
      { category: "other", summary: "one more" },
      {
        env: noEmail,
      },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
  });

  test("takes a person's message from the dashboard, with their page and workspace", async () => {
    const { user, cookie } = await testing.signIn(env);
    const { workspace, cookie: jar } = await testing.createWorkspace(
      env,
      cookie,
      "Dashboard feedback",
      "dashboard-feedback",
    );
    const send = vi.fn(async () => ({ messageId: "m2" }));
    const withEmail = { ...env, EMAIL: { send } as unknown as SendEmail };

    const response = await testing.call(withEmail, "/feedback", jar, {
      message: "Love the router page.\nCould it show cost too? password=hunter22",
      page: "/router?tab=rules",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { id: string; redacted: number };
    expect(body).toEqual({ id: expect.any(String), redacted: 1 });

    const row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
      .bind(body.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      user_id: user.id,
      workspace_id: workspace.id,
      source: "dashboard",
      client_id: null,
      summary: "Love the router page.",
      details: "Love the router page.\nCould it show cost too? password=[redacted]",
      page: "/router",
    });

    expect(send).toHaveBeenCalledOnce();
    const message = (send.mock.calls[0] as unknown[])[0] as {
      to: string;
      replyTo: string;
      subject: string;
      text: string;
    };
    expect(message.to).toBe("feedback@relayrunner.app");
    expect(message.replyTo).toBe(user.email);
    expect(message.subject).toBe("[feedback] Love the router page.");
    expect(message.text).toContain(`From: ${user.name} <${user.email}>`);
    expect(message.text).toContain("Workspace: Dashboard feedback");
    expect(message.text).toContain("Page: /router");
    expect(message.text).not.toContain("hunter22");

    expect((await testing.call(env, "/feedback", jar, { message: " \u200b " })).status).toBe(400);
    expect((await testing.call(env, "/feedback", jar, {})).status).toBe(400);
  });

  test("needs a signed-in person", async () => {
    const response = await app.request(
      "/api/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.BETTER_AUTH_URL },
        body: JSON.stringify({ message: "hi" }),
      },
      env,
    );
    expect(response.status).toBe(401);
  });
});
