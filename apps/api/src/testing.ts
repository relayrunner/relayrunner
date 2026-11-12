import { readdirSync, readFileSync } from "node:fs";
import { makeSignature } from "better-auth/crypto";
import { expect } from "vitest";
import { getPlatformProxy } from "wrangler";
import { app } from "./app.ts";
import { createAuth } from "./auth.ts";
import type { Env } from "./env.ts";
import { createTestD1 } from "./testing-d1.ts";

// Test helpers for running the app against an in-memory D1 (testing-d1.ts) with the committed
// migrations; the other bindings come from Miniflare. Call startD1() in beforeAll and dispose the
// proxy in afterAll.
// `before` stops short of the migration with that file name, for testing a migration on data.
export async function startD1({ before }: { before?: string } = {}) {
  const proxy = await getPlatformProxy<Env>({
    configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    persist: false,
  });
  const env: Env = {
    ...proxy.env,
    DB: createTestD1(),
    BETTER_AUTH_URL: "http://localhost:8787",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_APP_CLIENT_ID: "id",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_SLUG: "relayrunner-test",
  };
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql") && (!before || name < before))
    .sort())
    await applyMigration(env, file);
  return { proxy, env };
}

const migrations = new URL("../migrations/", import.meta.url);

export async function applyMigration(env: Env, file: string) {
  for (const statement of readFileSync(new URL(file, migrations), "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (statement.trim()) await env.DB.prepare(statement).run();
  }
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
  // As if their memberships were just read from GitHub, so listing workspaces doesn't ask GitHub
  // (memberships.test.ts covers the sync).
  await env.DB.prepare("update user set installations_synced_at = ? where id = ?")
    .bind(Date.now(), user.id)
    .run();
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

let installations = 0;

// A workspace owned by the signed-in user, made active. Users can't create workspaces (#316):
// each is a GitHub App installation, so this records a stand-in installation (id
// `workspace.installationId`) and its workspace, the way the Setup URL would. A test that needs a
// particular installation swaps it in with useInstallation.
export async function createWorkspace(env: Env, cookie: string, name: string, slug: string) {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(session).not.toBeNull();
  const userId = session!.user.id;
  installations += 1;
  const installationId = 900_000_000 + installations;
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (?, ?, ?, 'Organization', ?, ?)",
    ).bind(installationId, installationId, slug, now, now),
    env.DB.prepare(
      "insert into workspace (id, installation_id, name, slug, created_at) values (?, ?, ?, ?, ?)",
    ).bind(id, installationId, name, slug, now),
    env.DB.prepare(
      "insert into workspace_member (id, workspace_id, user_id, role, created_at) values (?, ?, ?, 'owner', ?)",
    ).bind(crypto.randomUUID(), id, userId, now),
  ]);
  const active = await call(env, "/auth/organization/set-active", cookie, { organizationId: id });
  expect(active.status).toBe(200);
  return {
    workspace: { id, name, slug, installationId, members: [{ userId, role: "owner" }] },
    cookie: withSetCookies(cookie, active),
  };
}

// Makes an installation the test already recorded the workspace's own, dropping the stand-in
// createWorkspace made.
export async function useInstallation(env: Env, workspaceId: string, installationId: number) {
  const row = await env.DB.prepare("select installation_id from workspace where id = ?")
    .bind(workspaceId)
    .first<{ installation_id: number }>();
  await env.DB.prepare("update workspace set installation_id = ? where id = ?")
    .bind(installationId, workspaceId)
    .run();
  if (row && row.installation_id !== installationId)
    await env.DB.prepare("delete from github_installation where id = ?")
      .bind(row.installation_id)
      .run();
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
// A shortcut past syncing their membership from GitHub (memberships.test.ts covers that).
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
