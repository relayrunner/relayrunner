import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb } from "../db/index.ts";
import type { Env } from "../env.ts";
import { app } from "../app.ts";
import * as testing from "../testing.ts";
import { connectionBearer, parseGrant } from "./boat-oauth.ts";
import { openToken, sealToken } from "./provider-tokens.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv({
    env: {
      PROVIDER_TOKEN_KEY: { get: async () => KEY },
      BOAT_OAUTH_CLIENT_ID: "boatapp_test",
      BOAT_OAUTH_CLIENT_SECRET: { get: async () => "client-secret" },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeBoat {
  plan?: string;
  dollars?: number;
  installs?: object[];
  refreshes: string[];
  tokenCalls: URLSearchParams[];
  limitsQueries: string[];
  refuseRefresh?: boolean;
}

/** Boat's token endpoint and API, enough for connecting and reading readiness. */
function stubBoat(boat: FakeBoat) {
  let issued = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/boat/oauth2/token") {
      const body = new URLSearchParams(String(init?.body));
      boat.tokenCalls.push(body);
      if (body.get("grant_type") === "refresh_token") {
        boat.refreshes.push(body.get("refresh_token")!);
        if (boat.refuseRefresh) return json({ error: "invalid_grant" }, 400);
      }
      issued++;
      return json({
        access_token: `boat_access_${issued}`,
        refresh_token: `boatrt_${issued}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "account.read",
      });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!auth.startsWith("Bearer boat_")) return json({ code: "unauthorized" }, 401);
    if (url.pathname === "/api/v1/me")
      return json({ ok: true, type: "user.info", user: { login: "octocat" } });
    if (url.pathname === "/api/v1/limits") {
      boat.limitsQueries.push(url.search);
      return json({
        ok: true,
        canStart: true,
        sandboxPlanKey: boat.plan ?? "box_20",
        sandboxPlanDollars: boat.dollars ?? 20,
      });
    }
    if (url.pathname === "/api/v1/ci")
      return json({ ok: true, type: "ci.overview", installations: boat.installs ?? [] });
    throw new Error(`unexpected ${url}`);
  });
}

const fakeBoat = (overrides: Partial<FakeBoat> = {}): FakeBoat => ({
  refreshes: [],
  tokenCalls: [],
  limitsQueries: [],
  ...overrides,
});

async function owner() {
  const { cookie } = await testing.signIn(env);
  const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;
  return testing.createWorkspace(env, cookie, "Acme", slug);
}

// On the production host, which Boat's redirect URI names.
const get = (path: string, cookie: string) =>
  Promise.resolve(
    app.request(`${env.BETTER_AUTH_URL}/api${path}`, { headers: { cookie } }, env),
  ).then(async (response) => ({
    response,
    location: response.headers.get("location"),
  }));

/** Goes through Connect Boat and back, as the browser would. */
async function connect(cookie: string, next = "/providers/boat/evaluate") {
  const start = await get(`/providers/boat/connect?next=${encodeURIComponent(next)}`, cookie);
  expect(start.response.status).toBe(302);
  const authorize = new URL(start.location!);
  const jar = testing.withSetCookies(cookie, start.response);
  const state = authorize.searchParams.get("state")!;
  const back = await get(`/providers/boat/callback?code=the-code&state=${state}`, jar);
  return { authorize, back };
}

describe("Connect Boat", () => {
  test("sends the browser to Boat's sign-in with PKCE and account.read only", async () => {
    stubBoat(fakeBoat());
    const { cookie } = await owner();
    const { authorize } = await connect(cookie);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://boat.dev/api/boat/oauth2/authorize",
    );
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "boatapp_test",
      redirect_uri: "http://localhost:8787/api/providers/boat/callback",
      scope: "account.read",
      code_challenge_method: "S256",
    });
    // The verifier never leaves our cookie.
    expect(authorize.searchParams.get("code_verifier")).toBeNull();
  });

  test("the callback saves the grant and lands back on Evaluate", async () => {
    const boat = fakeBoat();
    stubBoat(boat);
    const { cookie, workspace } = await owner();
    const { back } = await connect(cookie);
    expect(back.location).toBe("/providers/boat/evaluate?boat=connected");
    const exchange = boat.tokenCalls[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("client_secret")).toBe("client-secret");
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);

    const row = await env.DB.prepare(
      "select token, token_hint, account_name from provider_connection where workspace_id = ? and provider = 'boat'",
    )
      .bind(workspace.id)
      .first<{ token: string; token_hint: string; account_name: string }>();
    expect(row).toMatchObject({ token_hint: "Boat sign-in", account_name: "octocat" });
    const grant = parseGrant(await openToken(env, workspace.id, "boat", row!.token));
    expect(grant).toMatchObject({ access: "boat_access_1", refresh: "boatrt_1" });
  });

  test("a mismatched state or a cancel saves nothing", async () => {
    stubBoat(fakeBoat());
    const { cookie, workspace } = await owner();
    const start = await get("/providers/boat/connect", cookie);
    const jar = testing.withSetCookies(cookie, start.response);
    const forged = await get("/providers/boat/callback?code=x&state=not-it", jar);
    expect(forged.location).toBe("/providers/boat/evaluate?boat=failed");

    const again = await get("/providers/boat/connect", cookie);
    const jar2 = testing.withSetCookies(cookie, again.response);
    const state = new URL(again.location!).searchParams.get("state");
    const cancelled = await get(
      `/providers/boat/callback?error=access_denied&state=${state}`,
      jar2,
    );
    expect(cancelled.location).toBe("/providers/boat/evaluate?boat=cancelled");
    const row = await env.DB.prepare(
      "select 1 from provider_connection where workspace_id = ? and provider = 'boat'",
    )
      .bind(workspace.id)
      .first();
    expect(row).toBeNull();
  });

  test("isn't offered without an OAuth app", async () => {
    const bare = await testing.createTestEnv({
      env: { PROVIDER_TOKEN_KEY: { get: async () => KEY }, BOAT_OAUTH_CLIENT_ID: "" },
    });
    const { cookie } = await testing.signIn(bare);
    const { cookie: active } = await testing.createWorkspace(bare, cookie, "Acme", "acme-bare");
    const response = await testing.call(bare, "/providers/boat/connect", active);
    expect(response.status).toBe(404);
    const readiness = (await (
      await testing.call(bare, "/providers/boat/readiness", active)
    ).json()) as { signIn: boolean };
    expect(readiness.signIn).toBe(false);
  });
});

describe("Boat readiness", () => {
  const install = (account: string, extra: object = {}) => ({
    id: "1",
    accountLogin: account,
    accountType: "User",
    teamId: null,
    manageUrl: "https://github.com/settings/installations/1",
    repositories: [
      { fullName: `${account}/api`, private: true, status: "ok", jobs7d: 0 },
      { fullName: `${account}/site`, private: false, status: "public-blocked", jobs7d: 0 },
    ],
    ...extra,
  });

  async function readiness(cookie: string) {
    const response = await testing.call(env, "/providers/boat/readiness", cookie);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  test("not connected", async () => {
    stubBoat(fakeBoat());
    const { cookie } = await owner();
    expect(await readiness(cookie)).toMatchObject({
      signIn: true,
      connected: false,
      ready: false,
      plan: null,
    });
  });

  test("on the trial, with no app yet", async () => {
    const boat = fakeBoat({ plan: "trial", dollars: 0 });
    stubBoat(boat);
    const { cookie } = await owner();
    await connect(cookie);
    expect(await readiness(cookie)).toMatchObject({
      connected: true,
      accountName: "octocat",
      plan: { key: "trial", runsCi: false },
      install: null,
      ready: false,
    });
    // No install says which wallet, so the active one.
    expect(boat.limitsQueries.at(-1)).toBe("");
  });

  test("ready once the plan runs CI and the app is on the workspace's account", async () => {
    const boat = fakeBoat();
    stubBoat(boat);
    const { cookie, workspace } = await owner();
    boat.installs = [install(workspace.slug, { teamId: "team_9" }), install("someone-else")];
    await connect(cookie);
    const read = await readiness(cookie);
    expect(read).toMatchObject({
      githubAccount: workspace.slug,
      plan: { key: "box_20", runsCi: true },
      install: {
        manageUrl: "https://github.com/settings/installations/1",
        repositories: [
          { fullName: `${workspace.slug}/api`, private: true, status: "ok" },
          { fullName: `${workspace.slug}/site`, private: false, status: "public-blocked" },
        ],
      },
      ready: true,
    });
    // The plan is read for the wallet the install bills.
    expect(boat.limitsQueries.at(-1)).toBe("?org=team_9");
  });

  test("a refused refresh asks to connect again", async () => {
    const boat = fakeBoat({ refuseRefresh: true });
    stubBoat(boat);
    const { cookie, workspace } = await owner();
    await connect(cookie);
    await expireGrant(workspace.id);
    expect(await readiness(cookie)).toMatchObject({
      connected: true,
      rejected: true,
      ready: false,
    });
  });
});

async function expireGrant(workspaceId: string) {
  const row = await env.DB.prepare(
    "select token from provider_connection where workspace_id = ? and provider = 'boat'",
  )
    .bind(workspaceId)
    .first<{ token: string }>();
  const grant = parseGrant(await openToken(env, workspaceId, "boat", row!.token))!;
  const sealed = await sealToken(
    env,
    workspaceId,
    "boat",
    JSON.stringify({ ...grant, expiresAt: Date.now() - 1000 }),
  );
  await env.DB.prepare(
    "update provider_connection set token = ? where workspace_id = ? and provider = 'boat'",
  )
    .bind(sealed, workspaceId)
    .run();
  return sealed;
}

describe("connectionBearer", () => {
  test("a pasted key is used as it is", async () => {
    const sealed = await sealToken(env, "w1", "boat", "boat_pasted_key");
    expect(await connectionBearer(env, createDb(env.DB), "w1", "boat", sealed)).toBe(
      "boat_pasted_key",
    );
  });

  test("an expiring grant is refreshed once, even when two callers need it at once", async () => {
    const boat = fakeBoat();
    stubBoat(boat);
    const { cookie, workspace } = await owner();
    await connect(cookie);
    const sealed = await expireGrant(workspace.id);
    const db = createDb(env.DB);
    const [a, b] = await Promise.all([
      connectionBearer(env, db, workspace.id, "boat", sealed),
      connectionBearer(env, db, workspace.id, "boat", sealed),
    ]);
    expect(boat.refreshes).toEqual(["boatrt_1"]);
    expect(a).toBe("boat_access_2");
    expect(b).toBe("boat_access_2");
    // The new refresh token is what's saved, for next time.
    const row = await env.DB.prepare(
      "select token from provider_connection where workspace_id = ? and provider = 'boat'",
    )
      .bind(workspace.id)
      .first<{ token: string }>();
    const saved = parseGrant(await openToken(env, workspace.id, "boat", row!.token));
    expect(saved).toMatchObject({ refresh: "boatrt_2" });
    expect(saved?.leaseUntil).toBeUndefined();
  });

  test("a fresh grant's access token is used without asking Boat", async () => {
    const boat = fakeBoat();
    stubBoat(boat);
    const { cookie, workspace } = await owner();
    await connect(cookie);
    const row = await env.DB.prepare(
      "select token from provider_connection where workspace_id = ? and provider = 'boat'",
    )
      .bind(workspace.id)
      .first<{ token: string }>();
    const calls = boat.tokenCalls.length;
    expect(await connectionBearer(env, createDb(env.DB), workspace.id, "boat", row!.token)).toBe(
      "boat_access_1",
    );
    expect(boat.tokenCalls.length).toBe(calls);
  });
});
