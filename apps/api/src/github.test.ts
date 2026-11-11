import { generateKeyPairSync } from "node:crypto";
import { toWebhookMessage } from "@relayrunner/github-webhooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import type { Env } from "./env.ts";
import { dashboardPath, type GitHubInstallation, verifyInstallState } from "./github.ts";
import { landingAfterSignIn } from "./routes/github.ts";
import * as testing from "./testing.ts";
import { processWebhook } from "./webhook-queue.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

// Uninstalling purges the workspace's Durable Objects, which the platform proxy doesn't run.
const purgedRouters: string[] = [];

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
  env = {
    ...env,
    MACHINE_LINK: {
      getByName: () => ({ purge: async () => {} }),
    } as unknown as Env["MACHINE_LINK"],
    ROUTER: {
      getByName: (id: string) => ({ purge: async () => void purgedRouters.push(id) }),
    } as unknown as Env["ROUTER"],
  };
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

// What GET /user/installations returns per bearer token. Tokens in `revoked` get a 401. Other URLs
// go to the real fetch, which Miniflare may be using.
const visibleTo = new Map<string, GitHubInstallation[]>();
const revoked = new Set<string>();

beforeEach(() => {
  visibleTo.clear();
  revoked.clear();
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.github.com/user/installations")) return realFetch(input, init);
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    if (revoked.has(token)) return Promise.resolve(new Response("{}", { status: 401 }));
    const installations = visibleTo.get(token) ?? [];
    return Promise.resolve(Response.json({ total_count: installations.length, installations }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let nextId = 100;

function installation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  nextId += 1;
  return {
    id: nextId,
    account: { id: nextId + 5000, login: `org-${nextId}`, type: "Organization" },
    repository_selection: "all",
    suspended_at: null,
    ...overrides,
  };
}

let workspaces = 0;

// A signed-in owner of a fresh workspace (testing.createWorkspace's stand-in installation).
async function owner() {
  const { user, githubToken, cookie } = await testing.signIn(env);
  workspaces += 1;
  const { workspace, cookie: jar } = await testing.createWorkspace(
    env,
    cookie,
    `Workspace ${workspaces}`,
    `github-test-${workspaces}`,
  );
  return { user, githubToken, workspace, cookie: jar };
}

const call = (path: string, cookie: string, body?: unknown) =>
  testing.call(env, path, cookie, body);

// The `state` the install link would carry for this user.
async function installState(cookie: string, next?: string) {
  const response = await call(
    `/github/install${next ? `?next=${encodeURIComponent(next)}` : ""}`,
    cookie,
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!).searchParams.get("state")!;
}

// GitHub's redirect back to the Setup URL. Returns where it sends the browser, and the cookie jar
// after it (it makes the installation's workspace active).
async function setupWith(cookie: string, installationId: number, state?: string) {
  const query = new URLSearchParams({
    installation_id: String(installationId),
    setup_action: "install",
  });
  if (state) query.set("state", state);
  const response = await call(`/github/setup?${query}`, cookie);
  expect(response.status).toBe(302);
  return {
    location: response.headers.get("location"),
    cookie: testing.withSetCookies(cookie, response),
  };
}

async function setup(cookie: string, installationId: number, state?: string) {
  return (await setupWith(cookie, installationId, state)).location;
}

async function current(cookie: string) {
  const response = await call("/workspaces/current", cookie);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    workspace: { id: string; name: string; slug: string; logo: string | null };
    role: string;
    installations: Record<string, unknown>[];
  };
}

// A GitHub delivery as it reaches the API: through the ingress Worker's message shape and the
// queue consumer.
async function webhook(event: string, payload: unknown, receivedAt?: string) {
  const message = toWebhookMessage(event, crypto.randomUUID(), payload, receivedAt);
  expect(message).not.toBeNull();
  await processWebhook(env, message!);
}

// The installation as stored, with its workspace's id (null when it has none).
const row = (id: number) =>
  env.DB.prepare(
    "select w.id as workspace_id, i.account_login, i.repository_selection, i.suspended_at from github_installation i left join workspace w on w.installation_id = i.id where i.id = ?",
  )
    .bind(id)
    .first<{
      workspace_id: string | null;
      account_login: string;
      repository_selection: string;
      suspended_at: number | null;
    }>();

const members = async (workspaceId: string) =>
  (
    await env.DB.prepare(
      "select user_id, role from workspace_member where workspace_id = ? order by created_at, role",
    )
      .bind(workspaceId)
      .all<{ user_id: string; role: string }>()
  ).results;

describe("installing the GitHub App makes a workspace (#316)", () => {
  test("/install redirects to the App install page with a state naming the user", async () => {
    const { user, cookie } = await testing.signIn(env);
    const response = await call("/github/install", cookie);
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://github.com/apps/relayrunner-test/installations/new",
    );
    const state = await verifyInstallState(
      env.BETTER_AUTH_SECRET,
      location.searchParams.get("state")!,
    );
    expect(state).toMatchObject({ userId: user.id });
  });

  test("/install needs a signed-in user, but no workspace", async () => {
    const response = await app.request("/api/github/install", {}, env);
    expect(response.status).toBe(401);
  });

  test("setup makes the installation's workspace, owned by the installer, and opens it", async () => {
    const { user, githubToken, cookie } = await testing.signIn(env);
    const github = installation({ repository_selection: "selected" });
    visibleTo.set(githubToken, [github]);

    const back = await setupWith(cookie, github.id, await installState(cookie));
    expect(back.location).toBe("/settings/github?github=connected");

    const { workspace_id } = (await row(github.id))!;
    expect(workspace_id).toBeTruthy();
    expect(await members(workspace_id!)).toEqual([{ user_id: user.id, role: "owner" }]);
    const login = github.account!.login;
    expect(await current(back.cookie)).toEqual({
      workspace: expect.objectContaining({
        id: workspace_id,
        name: login,
        slug: login,
        logo: `https://avatars.githubusercontent.com/u/${github.account!.id}?v=4`,
      }),
      role: "owner",
      installations: [
        {
          id: github.id,
          accountLogin: login,
          accountType: "Organization",
          repositorySelection: "selected",
          suspendedAt: null,
          settingsUrl: `https://github.com/organizations/${login}/settings/installations/${github.id}`,
        },
      ],
    });
  });

  test("each installation is its own workspace", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const first = installation();
    const second = installation({ account: { id: 77, login: "Octocat", type: "User" } });
    visibleTo.set(githubToken, [first, second]);

    await setup(cookie, first.id);
    const back = await setupWith(cookie, second.id);

    const one = (await row(first.id))!.workspace_id;
    const two = (await row(second.id))!.workspace_id;
    expect(one).not.toBe(two);
    // The latest install is the one that opens, and a personal account's slug is lowercased.
    expect(await current(back.cookie)).toMatchObject({
      workspace: { id: two, name: "Octocat", slug: "octocat" },
      installations: [
        expect.objectContaining({
          accountType: "User",
          settingsUrl: `https://github.com/settings/installations/${second.id}`,
        }),
      ],
    });
  });

  test("a second person who can see the installation joins its workspace as a member", async () => {
    const first = await testing.signIn(env);
    const second = await testing.signIn(env);
    const github = installation();
    visibleTo.set(first.githubToken, [github]);
    visibleTo.set(second.githubToken, [github]);
    await setup(first.cookie, github.id);

    expect(await setup(second.cookie, github.id)).toBe("/settings/github?github=connected");
    const { workspace_id } = (await row(github.id))!;
    expect(await members(workspace_id!)).toEqual([
      { user_id: first.user.id, role: "owner" },
      { user_id: second.user.id, role: "member" },
    ]);
  });

  test("the installation webhook and setup land on one workspace, whichever comes first", async () => {
    const { user, githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);

    await webhook("installation", { action: "created", installation: github });
    const made = (await row(github.id))!.workspace_id;
    expect(made).toBeTruthy();
    expect(await members(made!)).toEqual([]);

    await setup(cookie, github.id);
    expect((await row(github.id))!.workspace_id).toBe(made);
    expect(await members(made!)).toEqual([{ user_id: user.id, role: "owner" }]);

    await webhook("installation", { action: "new_permissions_accepted", installation: github });
    expect((await row(github.id))!.workspace_id).toBe(made);
  });

  test("an installation the token cannot see is not found, and makes nothing", async () => {
    const { cookie } = await testing.signIn(env);
    const github = installation();

    expect(await setup(cookie, github.id, await installState(cookie))).toBe(
      "/settings/github?github=not_found",
    );
    expect(await row(github.id)).toBeNull();
  });

  test("coming back after changing an installation on GitHub reads as updated", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    await setup(cookie, github.id, await installState(cookie));

    visibleTo.set(githubToken, [{ ...github, repository_selection: "selected" }]);

    expect(await setup(cookie, github.id)).toBe("/settings/github?github=updated");
    expect(await row(github.id)).toMatchObject({ repository_selection: "selected" });
  });

  test("a renamed account renames its workspace", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    await setup(cookie, github.id);

    const renamed = { ...github, account: { ...github.account!, login: `Renamed-${github.id}` } };
    await webhook("installation", { action: "new_permissions_accepted", installation: renamed });

    const workspace = await env.DB.prepare(
      "select name, slug from workspace where installation_id = ?",
    )
      .bind(github.id)
      .first();
    expect(workspace).toEqual({ name: `Renamed-${github.id}`, slug: `renamed-${github.id}` });
  });

  test("a state that's tampered with or someone else's only loses the landing page", async () => {
    const first = await testing.signIn(env);
    const second = await testing.signIn(env);
    const github = installation();
    visibleTo.set(second.githubToken, [github]);
    const state = await installState(second.cookie, "/runners");
    const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;

    expect(await setup(second.cookie, github.id, tampered)).toBe(
      "/settings/github?github=connected",
    );
    // GitHub, not the state, decides who joins: first's state doesn't add first.
    await setup(second.cookie, github.id, await installState(first.cookie, "/runners"));
    expect(await members((await row(github.id))!.workspace_id!)).toEqual([
      { user_id: second.user.id, role: "owner" },
    ]);
  });

  test("a revoked GitHub token asks the user to sign in again", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    revoked.add(githubToken);

    expect(await setup(cookie, github.id)).toBe("/settings/github?github=reauth");
    expect(await row(github.id)).toBeNull();
  });

  test("setup explains requests, bad ids, and signed-out returns", async () => {
    const { cookie } = await testing.signIn(env);

    const requested = await call("/github/setup?setup_action=request", cookie);
    expect(requested.headers.get("location")).toBe("/settings/github?github=requested");

    const invalid = await call("/github/setup?installation_id=nope", cookie);
    expect(invalid.headers.get("location")).toBe("/settings/github?github=invalid");

    const signedOut = await app.request("/api/github/setup?installation_id=1", {}, env);
    // Signs in with GitHub, then comes back to setup (landingAfterSignIn).
    expect(new URL(signedOut.headers.get("location")!).pathname).toBe("/login/oauth/authorize");
  });

  test("users can't create workspaces, and the claim endpoints are gone", async () => {
    const { cookie } = await testing.signIn(env);
    const created = await call("/auth/organization/create", cookie, { name: "Mine", slug: "mine" });
    expect(created.status).toBe(403);
    expect((await call("/github/installations/unclaimed", cookie)).status).toBe(404);
    expect((await call("/github/installations/1/claim", cookie, {})).status).toBe(404);
  });

  test("a member can see the workspace's installation", async () => {
    const { workspace } = await owner();
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    expect(await current(member.cookie)).toMatchObject({
      role: "member",
      installations: [expect.objectContaining({ id: workspace.installationId })],
    });
  });
});

describe("coming back to a dashboard page after the install (next)", () => {
  const device = "/device?user_code=ABCDEFGH&name=my-laptop";

  test("/install carries next in the signed state", async () => {
    const { cookie } = await testing.signIn(env);
    const state = await verifyInstallState(
      env.BETTER_AUTH_SECRET,
      await installState(cookie, device),
    );
    expect(state?.next).toBe(device);
  });

  test("setup makes the workspace and returns to next with the outcome", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);

    expect(await setup(cookie, github.id, await installState(cookie, device))).toBe(
      `${device}&github=connected`,
    );
    expect((await row(github.id))!.workspace_id).toBeTruthy();
  });

  test("an install request from a non-admin also returns to next", async () => {
    const { cookie } = await testing.signIn(env);
    const state = await installState(cookie, device);
    const response = await call(
      `/github/setup?setup_action=request&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(response.headers.get("location")).toBe(`${device}&github=requested`);
  });

  test("signed out on the way back, it signs in with GitHub", async () => {
    const { cookie } = await testing.signIn(env);
    const state = await installState(cookie, device);
    const response = await app.request(
      `/api/github/setup?installation_id=1&state=${encodeURIComponent(state)}`,
      {},
      env,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(response.headers.getSetCookie().join("\n")).toContain("better-auth.state");
  });

  test("after that sign-in it comes back to setup, carrying next", () => {
    expect(landingAfterSignIn({ next: device, requested: false, installationId: 9 })).toBe(
      `/api/github/setup?installation_id=9&next=${encodeURIComponent(device)}`,
    );
    expect(landingAfterSignIn({ next: device, requested: true, installationId: null })).toBe(
      `${device}&github=requested`,
    );
    expect(landingAfterSignIn({ next: null, requested: false, installationId: 9 })).toBe(
      "/api/github/setup?installation_id=9",
    );
    expect(landingAfterSignIn({ next: null, requested: false, installationId: null })).toBe(
      "/settings/github?github=invalid",
    );
  });

  test("setup's own next, from that return trip, only points inside the dashboard", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    const back = await call(
      `/github/setup?installation_id=${github.id}&next=${encodeURIComponent(device)}`,
      cookie,
    );
    expect(back.headers.get("location")).toBe(`${device}&github=connected`);
    const evil = await call(
      `/github/setup?installation_id=${github.id}&next=${encodeURIComponent("https://evil.example/")}`,
      cookie,
    );
    expect(evil.headers.get("location")).toBe("/settings/github?github=updated");
  });

  test("/signup goes straight to the install page and remembers next in a cookie", async () => {
    const response = await app.request(
      `${env.BETTER_AUTH_URL}/api/github/signup?next=${encodeURIComponent(device)}`,
      {},
      env,
    );
    expect(response.headers.get("location")).toBe(
      "https://github.com/apps/relayrunner-test/installations/new",
    );
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("rr_signup_next="));
    expect(cookie).toContain(encodeURIComponent(device));
    expect(cookie).toContain("HttpOnly");
  });

  test("/signup on another host moves to the production host first", async () => {
    const response = await app.request(
      `https://preview.example/api/github/signup?next=${encodeURIComponent(device)}`,
      {},
      env,
    );
    expect(response.headers.get("location")).toBe(
      `${new URL(env.BETTER_AUTH_URL).origin}/api/github/signup?next=${encodeURIComponent(device)}`,
    );
  });

  test("setup with the signup cookie signs a new user in with GitHub's code, then makes their workspace", async () => {
    const realFetch = globalThis.fetch;
    const exchanged: string[] = [];
    const github = installation();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        exchanged.push(String(init?.body));
        return Promise.resolve(Response.json({ access_token: "gho_new", token_type: "bearer" }));
      }
      if (url === "https://api.github.com/user")
        return Promise.resolve(
          Response.json({ id: 424242, login: "newbie", name: "New Bie", email: null }),
        );
      if (url === "https://api.github.com/user/emails")
        return Promise.resolve(
          Response.json([{ email: "newbie@example.com", primary: true, verified: true }]),
        );
      if (url.startsWith("https://api.github.com/user/installations"))
        return Promise.resolve(Response.json({ total_count: 1, installations: [github] }));
      return realFetch(input, init);
    });
    const response = await app.request(
      `${env.BETTER_AUTH_URL}/api/github/setup?code=abc&installation_id=${github.id}&setup_action=install`,
      { headers: { cookie: `rr_signup_next=${encodeURIComponent(device)}` } },
      env,
    );
    const back = response.headers.get("location")!;
    expect(back).toBe(
      `/api/github/setup?installation_id=${github.id}&next=${encodeURIComponent(device)}`,
    );
    // The code is exchanged for the callback URL GitHub sent it to.
    expect(exchanged[0]).toContain(encodeURIComponent(`${env.BETTER_AUTH_URL}/api/github/setup`));
    const session = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("better-auth.session_token="));
    expect(session).toBeTruthy();
    const cookie = session!.split(";")[0]!;
    const me = await app.request("/api/auth/get-session", { headers: { cookie } }, env);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(
      "newbie@example.com",
    );

    // Back at setup, signed in now: the installation's workspace is made, with them as owner.
    const done = await app.request(back, { headers: { cookie } }, env);
    expect(done.headers.get("location")).toBe(`${device}&github=connected`);
    expect((await current(testing.withSetCookies(cookie, done))).role).toBe("owner");
  });

  test("the install sign-in can't be called over HTTP", async () => {
    const response = await call("/auth/github/install-sign-in", "", { code: "abc" });
    expect(response.status).toBe(404);
  });

  test("when GitHub refuses the code, setup falls back to a GitHub sign-in", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://github.com/login/oauth/access_token")
        return Promise.resolve(Response.json({ error: "bad_verification_code" }));
      return realFetch(input, init);
    });
    const response = await app.request(
      `${env.BETTER_AUTH_URL}/api/github/setup?code=abc&installation_id=5&setup_action=install`,
      { headers: { cookie: `rr_signup_next=${encodeURIComponent(device)}` } },
      env,
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login/oauth/authorize");
  });

  test("setup with the signup cookie, already signed in, lands on next", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    const response = await call(
      `/github/setup?code=abc&installation_id=${github.id}&setup_action=install`,
      `${cookie}; rr_signup_next=${encodeURIComponent(device)}`,
    );
    expect(response.headers.get("location")).toBe(`${device}&github=connected`);
  });

  test("when GitHub drops the state, /install's cookie still finds next", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    const state = await installState(cookie, device);
    const response = await call(
      `/github/setup?code=abc&installation_id=${github.id}&setup_action=install`,
      `${cookie}; rr_install_state=${encodeURIComponent(state)}`,
    );
    expect(response.headers.get("location")).toBe(`${device}&github=connected`);
    expect((await row(github.id))!.workspace_id).toBeTruthy();
  });

  test("setup on another host hands back to the origin the install started on", async () => {
    const { cookie } = await testing.signIn(env);
    const state = await installState(cookie, device);
    expect((await verifyInstallState(env.BETTER_AUTH_SECRET, state))?.origin).toBe(
      "http://localhost",
    );
    // GitHub's Setup URL is a fixed host where the session cookie doesn't live.
    const query = `installation_id=1&setup_action=install&state=${encodeURIComponent(state)}`;
    const response = await app.request(`https://app.example/api/github/setup?${query}`, {}, env);
    expect(response.headers.get("location")).toBe(`http://localhost/api/github/setup?${query}`);
  });

  test("next only ever points inside the dashboard", async () => {
    const { cookie } = await testing.signIn(env);
    for (const next of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "device",
    ]) {
      const state = await verifyInstallState(
        env.BETTER_AUTH_SECRET,
        await installState(cookie, next),
      );
      expect(state?.next).toBeUndefined();
    }
    expect(dashboardPath("/device?user_code=A#frag")).toBe("/device?user_code=A");
  });
});

describe("installation webhooks (queue consumer)", () => {
  test("created records the installation and makes its workspace, with no members yet", async () => {
    const github = installation();
    await webhook("installation", { action: "created", installation: github });
    expect(await row(github.id)).toEqual({
      workspace_id: expect.any(String),
      account_login: github.account!.login,
      repository_selection: "all",
      suspended_at: null,
    });
    expect(await members((await row(github.id))!.workspace_id!)).toEqual([]);
  });

  test("suspend and unsuspend update status and keep the workspace", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    const { cookie: jar } = await setupWith(cookie, github.id);
    const { workspace_id } = (await row(github.id))!;

    await webhook("installation", {
      action: "suspend",
      installation: { ...github, suspended_at: "2026-11-04T12:00:00Z" },
    });
    expect(await row(github.id)).toMatchObject({
      workspace_id,
      suspended_at: expect.any(Number),
    });
    expect((await current(jar)).installations).toEqual([
      expect.objectContaining({ suspendedAt: "2026-11-04T12:00:00.000Z" }),
    ]);

    await webhook("installation", { action: "unsuspend", installation: github });
    expect(await row(github.id)).toMatchObject({ workspace_id, suspended_at: null });
  });

  test("an older delivery arriving late does not undo a newer one", async () => {
    const github = installation();
    const later = new Date(Date.now() + 60_000).toISOString();
    const earlier = new Date(Date.now() + 30_000).toISOString();
    await webhook("installation", { action: "created", installation: github }, earlier);
    // unsuspend was received after suspend, but the queue retried suspend and delivered it last.
    await webhook("installation", { action: "unsuspend", installation: github }, later);
    await webhook(
      "installation",
      { action: "suspend", installation: { ...github, suspended_at: "2026-11-04T12:00:00Z" } },
      earlier,
    );
    expect(await row(github.id)).toMatchObject({ suspended_at: null });
  });

  test("deleted deletes the workspace and everything under it", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    const { cookie: jar } = await setupWith(cookie, github.id);
    const { workspace_id } = (await row(github.id))!;

    await webhook("installation", { action: "deleted", installation: github });

    expect(await row(github.id)).toBeNull();
    expect(
      await env.DB.prepare("select id from workspace where id = ?").bind(workspace_id).first(),
    ).toBeNull();
    expect(await members(workspace_id!)).toEqual([]);
    expect(purgedRouters).toContain(workspace_id);
    expect((await call("/workspaces/current", jar)).status).toBe(409);
  });

  test("deleted from an ingress without the installation summary still removes the org", async () => {
    const github = installation();
    await webhook("installation", { action: "created", installation: github });

    const message = toWebhookMessage("installation", crypto.randomUUID(), {
      action: "deleted",
      installation: github,
    });
    await processWebhook(env, { ...message!, installation: null } as NonNullable<typeof message>);

    expect(await row(github.id)).toBeNull();
  });

  test("a stale event after deleted makes a fresh, empty workspace", async () => {
    const { githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    visibleTo.set(githubToken, [github]);
    await setup(cookie, github.id);
    const before = (await row(github.id))!.workspace_id;
    await webhook("installation", { action: "deleted", installation: github });

    await webhook(
      "installation",
      { action: "suspend", installation: github },
      new Date(Date.now() - 60_000).toISOString(),
    );

    const after = (await row(github.id))!.workspace_id;
    expect(after).not.toBe(before);
    expect(await members(after!)).toEqual([]);
  });

  test("installation_repositories updates the repository selection", async () => {
    const github = installation();
    await webhook("installation", { action: "created", installation: github });
    const { workspace_id } = (await row(github.id))!;

    await webhook("installation_repositories", {
      action: "removed",
      repository_selection: "selected",
      installation: github,
    });

    expect(await row(github.id)).toMatchObject({ workspace_id, repository_selection: "selected" });
  });
});

describe("repository webhooks (queue consumer)", () => {
  let nextRepoId = 9000;

  function repo(
    owner: string,
    overrides: Partial<{ id: number; full_name: string; private: boolean }> = {},
  ) {
    nextRepoId += 1;
    return {
      id: nextRepoId,
      name: `repo-${nextRepoId}`,
      full_name: `${owner}/repo-${nextRepoId}`,
      private: true,
      ...overrides,
    };
  }

  // The repos stored for an installation, current ones first-class and removed ones flagged.
  async function repos(installationId: number) {
    const { results } = await env.DB.prepare(
      "select id, full_name, private, removed_at from github_repository where installation_id = ? order by id",
    )
      .bind(installationId)
      .all<{ id: number; full_name: string; private: number; removed_at: number | null }>();
    return results.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      private: row.private === 1,
      removed: row.removed_at !== null,
    }));
  }

  const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  test("created saves every repo the installation can see, beyond one statement's worth", async () => {
    const github = installation();
    const list = Array.from({ length: 30 }, () => repo(github.account!.login));
    await webhook("installation", { action: "created", installation: github, repositories: list });
    expect(await repos(github.id)).toEqual(
      list.map((r) => ({ id: r.id, fullName: r.full_name, private: true, removed: false })),
    );
  });

  test("installation_repositories adds and removes repos", async () => {
    const github = installation();
    const [a, b, c] = [
      repo(github.account!.login),
      repo(github.account!.login),
      repo(github.account!.login, { private: false }),
    ];
    await webhook(
      "installation",
      {
        action: "created",
        installation: { ...github, repository_selection: "selected" },
        repositories: [a, b],
      },
      later(1),
    );
    await webhook(
      "installation_repositories",
      {
        action: "added",
        repository_selection: "selected",
        installation: github,
        repositories_added: [c],
        repositories_removed: [],
      },
      later(2),
    );
    await webhook(
      "installation_repositories",
      {
        action: "removed",
        repository_selection: "selected",
        installation: github,
        repositories_added: [],
        repositories_removed: [a],
      },
      later(3),
    );
    expect(await repos(github.id)).toEqual([
      { id: a.id, fullName: a.full_name, private: true, removed: true },
      { id: b.id, fullName: b.full_name, private: true, removed: false },
      { id: c.id, fullName: c.full_name, private: false, removed: false },
    ]);
  });

  test('a retried "added" that lands after a newer "removed" does not bring the repo back', async () => {
    const github = installation();
    const a = repo(github.account!.login);
    await webhook(
      "installation",
      { action: "created", installation: github, repositories: [] },
      later(1),
    );
    await webhook(
      "installation_repositories",
      {
        action: "removed",
        installation: github,
        repositories_added: [],
        repositories_removed: [a],
      },
      later(3),
    );
    await webhook(
      "installation_repositories",
      { action: "added", installation: github, repositories_added: [a], repositories_removed: [] },
      later(2),
    );
    // The removal leaves a tombstone even for a repo we never stored, so the stale add can't win.
    expect(await repos(github.id)).toEqual([
      { id: a.id, fullName: a.full_name, private: true, removed: true },
    ]);

    await webhook(
      "installation_repositories",
      { action: "added", installation: github, repositories_added: [a], repositories_removed: [] },
      later(4),
    );
    await webhook(
      "installation_repositories",
      {
        action: "removed",
        installation: github,
        repositories_added: [],
        repositories_removed: [a],
      },
      later(6),
    );
    await webhook(
      "installation_repositories",
      { action: "added", installation: github, repositories_added: [a], repositories_removed: [] },
      later(5),
    );
    expect(await repos(github.id)).toEqual([
      { id: a.id, fullName: a.full_name, private: true, removed: true },
    ]);
  });

  test("repository events add new repos and keep name and visibility current", async () => {
    const github = installation();
    const owner = github.account!.login;
    await webhook(
      "installation",
      { action: "created", installation: github, repositories: [] },
      later(1),
    );
    const a = repo(owner);

    await webhook(
      "repository",
      { action: "created", installation: { id: github.id }, repository: a },
      later(2),
    );
    await webhook(
      "repository",
      {
        action: "renamed",
        installation: { id: github.id },
        repository: { ...a, full_name: `${owner}/renamed` },
      },
      later(3),
    );
    await webhook(
      "repository",
      {
        action: "publicized",
        installation: { id: github.id },
        repository: { ...a, full_name: `${owner}/renamed`, private: false },
      },
      later(4),
    );
    // An older rename retried late changes nothing.
    await webhook(
      "repository",
      {
        action: "renamed",
        installation: { id: github.id },
        repository: { ...a, full_name: `${owner}/stale` },
      },
      later(3.5),
    );
    expect(await repos(github.id)).toEqual([
      { id: a.id, fullName: `${owner}/renamed`, private: false, removed: false },
    ]);

    await webhook(
      "repository",
      { action: "deleted", installation: { id: github.id }, repository: a },
      later(5),
    );
    expect(await repos(github.id)).toEqual([expect.objectContaining({ id: a.id, removed: true })]);
  });

  test("a repo transferred to another account is removed; one transferred in is added", async () => {
    const github = installation();
    const owner = github.account!.login;
    const out = repo(owner);
    await webhook(
      "installation",
      { action: "created", installation: github, repositories: [out] },
      later(1),
    );

    await webhook(
      "repository",
      {
        action: "transferred",
        installation: { id: github.id },
        repository: { ...out, full_name: "someone-else/moved" },
      },
      later(2),
    );
    const incoming = repo(owner);
    await webhook(
      "repository",
      { action: "transferred", installation: { id: github.id }, repository: incoming },
      later(3),
    );

    expect(await repos(github.id)).toEqual([
      expect.objectContaining({ id: out.id, removed: true }),
      { id: incoming.id, fullName: incoming.full_name, private: true, removed: false },
    ]);
  });

  test("a repo moving between two connected accounts ends up with the new one, whichever event lands first", async () => {
    const from = installation();
    const to = installation();
    const a = repo(from.account!.login);
    await webhook(
      "installation",
      { action: "created", installation: from, repositories: [a] },
      later(1),
    );
    await webhook(
      "installation",
      { action: "created", installation: to, repositories: [] },
      later(1),
    );
    const moved = { ...a, full_name: `${to.account!.login}/${a.name}` };

    await webhook(
      "repository",
      { action: "transferred", installation: { id: to.id }, repository: moved },
      later(2),
    );
    await webhook(
      "repository",
      { action: "transferred", installation: { id: from.id }, repository: moved },
      later(2),
    );

    expect(await repos(from.id)).toEqual([]);
    expect(await repos(to.id)).toEqual([
      { id: a.id, fullName: moved.full_name, private: true, removed: false },
    ]);
  });

  test("a repository event for an installation we have no row for is skipped", async () => {
    const a = repo("nobody");
    await webhook("repository", { action: "created", installation: { id: 424242 }, repository: a });
    const stored = await env.DB.prepare("select id from github_repository where id = ?")
      .bind(a.id)
      .first();
    expect(stored).toBeNull();
  });

  test("uninstalling removes the installation's repos", async () => {
    const github = installation();
    await webhook(
      "installation",
      { action: "created", installation: github, repositories: [repo(github.account!.login)] },
      later(1),
    );
    await webhook("installation", { action: "deleted", installation: github }, later(2));
    expect(await repos(github.id)).toEqual([]);
  });
});

describe("installation rate limits (#166)", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const appEnv = () =>
    ({
      ...env,
      GITHUB_APP_ID: "5605512",
      GITHUB_APP_PRIVATE_KEY: { get: async () => pem },
    }) as Env;
  const get = (path: string, cookie: string) =>
    app.request(`/api${path}`, { headers: { cookie } }, appEnv());

  // GitHub as the App sees it: a token per installation, then GET /rate_limit with it.
  let tokenRequests: number[] = [];
  let rateLimitStatus = 200;
  beforeEach(() => {
    tokenRequests = [];
    rateLimitStatus = 200;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const minted = url.match(
        /^https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/,
      );
      if (minted) {
        tokenRequests.push(Number(minted[1]));
        return Promise.resolve(Response.json({ token: `ghs_${minted[1]}` }, { status: 201 }));
      }
      if (url === "https://api.github.com/rate_limit") {
        const auth = new Headers(init?.headers).get("authorization");
        if (rateLimitStatus !== 200 || !auth?.startsWith("Bearer ghs_"))
          return Promise.resolve(new Response("{}", { status: rateLimitStatus }));
        return Promise.resolve(
          Response.json({
            resources: {
              core: { limit: 5000, used: 120, remaining: 4880, reset: 1_794_000_000 },
              graphql: { limit: 5000, used: 0, remaining: 5000, reset: 1_794_000_100 },
              search: { limit: 30, used: 0, remaining: 30, reset: 1_794_000_000 },
            },
          }),
        );
      }
      return realFetch(input, init);
    });
  });

  async function connected(workspaceId: string | null) {
    const github = installation();
    const now = Date.now();
    await env.DB.prepare(
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    )
      .bind(github.id, github.account!.id, github.account!.login, "Organization", now, now)
      .run();
    if (workspaceId) await testing.useInstallation(env, workspaceId, github.id);
    return github.id;
  }

  test("a member reads the installation's buckets live from GitHub", async () => {
    const { workspace } = await owner();
    const id = await connected(workspace.id);
    const member = await testing.joinWorkspace(env, workspace.id, "member");

    const response = await get(`/github/installations/${id}/rate-limit`, member.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      core: {
        limit: 5000,
        used: 120,
        remaining: 4880,
        reset: new Date(1_794_000_000 * 1000).toISOString(),
      },
      graphql: {
        limit: 5000,
        used: 0,
        remaining: 5000,
        reset: new Date(1_794_000_100 * 1000).toISOString(),
      },
      actionsRunnerRegistration: null,
    });
    expect(tokenRequests).toEqual([id]);
  });

  test("another workspace's installation, or one with no workspace, is not found", async () => {
    const { workspace } = await owner();
    const other = await owner();
    const theirs = await connected(workspace.id);
    const orphan = await connected(null);
    for (const id of [theirs, orphan, 0]) {
      const response = await get(`/github/installations/${id}/rate-limit`, other.cookie);
      expect(response.status).toBe(404);
    }
    expect(tokenRequests).toEqual([]);
  });

  test("a GitHub failure reads as unavailable", async () => {
    const { workspace, cookie } = await owner();
    const id = await connected(workspace.id);
    rateLimitStatus = 503;
    const response = await get(`/github/installations/${id}/rate-limit`, cookie);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "github_unavailable" });
  });
});
