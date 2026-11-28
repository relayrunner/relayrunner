import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Env } from "../env.ts";
import { app } from "../app.ts";
import * as testing from "../testing.ts";
import { openToken } from "./provider-tokens.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv({
    env: {
      PROVIDER_TOKEN_KEY: { get: async () => KEY },
      GROUNDBOX_OAUTH_CLIENT_ID: "gbc_relayrunner_test",
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeGroundbox {
  tokenCalls: URLSearchParams[];
  revoked: string[];
  refuseCode?: boolean;
}

/** Groundbox's token and revoke endpoints, and enough of its API for a connection's first read. */
function stubGroundbox(groundbox: FakeGroundbox) {
  let issued = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      groundbox.tokenCalls.push(body);
      if (groundbox.refuseCode) return json({ error: "invalid_grant" }, 400);
      issued++;
      return json({
        access_token: `gbx_signin_${issued}`,
        token_type: "Bearer",
        scope: "account:read billing:read",
      });
    }
    if (url.pathname === "/oauth/revoke") {
      groundbox.revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return json({});
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!auth.startsWith("Bearer gbx_")) return json({ error: { code: "unauthorized" } }, 401);
    // Anything the connection's first read asks for: an account that's fine.
    return json({
      team: { id: "team_1", name: "acme" },
      plan: "free",
      balance_micros: 5_000_000,
      ci_minutes: { used: 0, included: 3000 },
      data: [],
    });
  });
}

const fakeGroundbox = (overrides: Partial<FakeGroundbox> = {}): FakeGroundbox => ({
  tokenCalls: [],
  revoked: [],
  ...overrides,
});

async function owner() {
  const { cookie } = await testing.signIn(env);
  const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;
  return testing.createWorkspace(env, cookie, "Acme", slug);
}

// On the production host, which the redirect URI names.
const get = (path: string, cookie: string) =>
  Promise.resolve(
    app.request(`${env.BETTER_AUTH_URL}/api${path}`, { headers: { cookie } }, env),
  ).then((response) => ({ response, location: response.headers.get("location") }));

/** Goes through Connect with Groundbox and back, as the browser would. */
async function connect(cookie: string, next = "/settings/providers") {
  const start = await get(`/providers/groundbox/connect?next=${encodeURIComponent(next)}`, cookie);
  expect(start.response.status).toBe(302);
  const authorize = new URL(start.location!);
  const jar = testing.withSetCookies(cookie, start.response);
  const state = authorize.searchParams.get("state")!;
  const back = await get(`/providers/groundbox/callback?code=gbo_the-code&state=${state}`, jar);
  return { authorize, back };
}

const connectionRow = (workspaceId: string) =>
  env.DB.prepare(
    "select token, token_hint from provider_connection where workspace_id = ? and provider = 'groundbox'",
  )
    .bind(workspaceId)
    .first<{ token: string; token_hint: string }>();

describe("Connect with Groundbox", () => {
  test("sends the browser to Groundbox's sign-in with PKCE and the two read scopes", async () => {
    stubGroundbox(fakeGroundbox());
    const { cookie } = await owner();
    const { authorize } = await connect(cookie);
    expect(authorize.origin + authorize.pathname).toBe("https://api.groundbox.dev/oauth/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "gbc_relayrunner_test",
      redirect_uri: "http://localhost:8787/api/providers/groundbox/callback",
      scope: "account:read billing:read",
      code_challenge_method: "S256",
    });
    expect(authorize.searchParams.get("code_verifier")).toBeNull();
  });

  test("the callback saves the key as the workspace's Groundbox connection", async () => {
    const groundbox = fakeGroundbox();
    stubGroundbox(groundbox);
    const { cookie, workspace } = await owner();
    const { back } = await connect(cookie);
    expect(back.location).toBe("/settings/providers?groundbox=connected");
    const exchange = groundbox.tokenCalls[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("gbo_the-code");
    expect(exchange.get("client_id")).toBe("gbc_relayrunner_test");
    expect(exchange.get("client_secret")).toBeNull();
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);

    const row = await connectionRow(workspace.id);
    expect(row?.token_hint).toBe("Groundbox sign-in");
    expect(await openToken(env, workspace.id, "groundbox", row!.token)).toBe("gbx_signin_1");

    const listed = (await (await testing.call(env, "/providers/connections", cookie)).json()) as {
      signIn: string[];
    };
    expect(listed.signIn).toEqual(["groundbox"]);
  });

  test("connecting again ends the old key, and removing ends the current one", async () => {
    const groundbox = fakeGroundbox();
    stubGroundbox(groundbox);
    const { cookie, workspace } = await owner();
    await connect(cookie);
    await connect(cookie);
    expect(groundbox.revoked).toEqual(["gbx_signin_1"]);

    const removed = await testing.call(
      env,
      "/providers/groundbox/connection",
      cookie,
      undefined,
      "DELETE",
    );
    expect(removed.status).toBe(200);
    expect(groundbox.revoked).toEqual(["gbx_signin_1", "gbx_signin_2"]);
    expect(await connectionRow(workspace.id)).toBeNull();
  });

  test("a mismatched state, a cancel or a refused code saves nothing", async () => {
    stubGroundbox(fakeGroundbox());
    const { cookie, workspace } = await owner();
    const start = await get("/providers/groundbox/connect", cookie);
    const jar = testing.withSetCookies(cookie, start.response);
    const forged = await get("/providers/groundbox/callback?code=x&state=not-it", jar);
    expect(forged.location).toBe("/settings/providers?groundbox=failed");

    const again = await get("/providers/groundbox/connect", cookie);
    const jar2 = testing.withSetCookies(cookie, again.response);
    const state = new URL(again.location!).searchParams.get("state");
    const cancelled = await get(
      `/providers/groundbox/callback?error=access_denied&state=${state}`,
      jar2,
    );
    expect(cancelled.location).toBe("/settings/providers?groundbox=cancelled");

    stubGroundbox(fakeGroundbox({ refuseCode: true }));
    const { back } = await connect(cookie);
    expect(back.location).toBe("/settings/providers?groundbox=failed");
    expect(await connectionRow(workspace.id)).toBeNull();
  });

  test("isn't offered without a client id", async () => {
    const bare = await testing.createTestEnv({
      env: { PROVIDER_TOKEN_KEY: { get: async () => KEY }, GROUNDBOX_OAUTH_CLIENT_ID: "" },
    });
    const { cookie } = await testing.signIn(bare);
    const { cookie: active } = await testing.createWorkspace(bare, cookie, "Acme", "acme-gbx-bare");
    expect((await testing.call(bare, "/providers/groundbox/connect", active)).status).toBe(404);
    const listed = (await (await testing.call(bare, "/providers/connections", active)).json()) as {
      signIn: string[];
    };
    expect(listed.signIn).toEqual([]);
  });
});
