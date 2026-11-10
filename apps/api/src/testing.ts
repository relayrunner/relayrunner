import { readdirSync, readFileSync } from "node:fs";
import { makeSignature } from "better-auth/crypto";
import { expect } from "vitest";
import { getPlatformProxy } from "wrangler";
import { app } from "./app.ts";
import { createAuth } from "./auth.ts";
import type { Env } from "./env.ts";

// Test helpers for running the app against a real (in-memory, Miniflare) D1 with the committed
// migrations. Call startD1() in beforeAll and dispose the proxy in afterAll.
export async function startD1() {
  const proxy = await getPlatformProxy<Env>({
    configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    persist: false,
  });
  const env: Env = {
    ...proxy.env,
    BETTER_AUTH_URL: "http://localhost:8787",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_APP_CLIENT_ID: "id",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_SLUG: "relayrunner-test",
  };
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(file, dir), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) await env.DB.prepare(statement).run();
    }
  }
  return { proxy, env };
}

let users = 0;

// A user with a session cookie and, like a real GitHub sign-in, a GitHub account holding a token.
export async function signIn(env: Env) {
  const ctx = await createAuth(env).$context;
  users += 1;
  const user = await ctx.internalAdapter.createUser(
    { name: `User ${users}`, email: `user${users}@example.com`, emailVerified: true },
    { method: "admin" },
  );
  const githubToken = `gho_user${users}`;
  const githubId = 1000 + users;
  await ctx.internalAdapter.createAccount({
    userId: user.id,
    providerId: "github",
    accountId: String(githubId),
    accessToken: githubToken,
  });
  const session = await ctx.internalAdapter.createSession(user.id);
  const signed = `${session.token}.${await makeSignature(session.token, env.BETTER_AUTH_SECRET)}`;
  return {
    user,
    githubId,
    githubToken,
    cookie: `better-auth.session_token=${encodeURIComponent(signed)}`,
  };
}

export function call(env: Env, path: string, cookie: string, body?: unknown) {
  const init: RequestInit =
    body === undefined
      ? { headers: { cookie } }
      : {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: env.BETTER_AUTH_URL },
          body: JSON.stringify(body),
        };
  return app.request(`/api${path}`, init, env);
}

// What the dashboard does: create, then set it active so the cached session cookie picks it up
// (organization/create updates the session row but not the cookie cache).
export async function createWorkspace(env: Env, cookie: string, name: string, slug: string) {
  const created = await call(env, "/auth/organization/create", cookie, { name, slug });
  expect(created.status).toBe(200);
  const workspace = (await created.json()) as {
    id: string;
    slug: string;
    members: { userId: string; role: string }[];
  };
  let jar = withSetCookies(cookie, created);
  const active = await call(env, "/auth/organization/set-active", jar, {
    organizationId: workspace.id,
  });
  expect(active.status).toBe(200);
  jar = withSetCookies(jar, active);
  return { workspace, cookie: jar };
}

// Keeps the cookies a response sets, like a browser would.
export function withSetCookies(cookie: string, response: Response) {
  const jar = new Map(cookie.split("; ").map((pair) => pair.split("=", 2) as [string, string]));
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

// A new user added to an existing workspace with the given role, with that workspace active.
// A shortcut past the invite flow (invites.test.ts covers that).
export async function joinWorkspace(env: Env, workspaceId: string, role: "admin" | "member") {
  const { user, githubToken, cookie } = await signIn(env);
  await createAuth(env).api.addMember({
    body: { organizationId: workspaceId, userId: user.id, role },
  });
  const active = await call(env, "/auth/organization/set-active", cookie, {
    organizationId: workspaceId,
  });
  expect(active.status).toBe(200);
  return { user, githubToken, cookie: withSetCookies(cookie, active) };
}
