import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";
import { accessEnv, accessJwt } from "./testing-access.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  const started = await testing.startD1();
  proxy = started.proxy;
  env = { ...started.env, ...accessEnv };
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function call(path: string, cookie: string, init: RequestInit = {}, jwt = true) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  if (jwt) headers.set("Cf-Access-Jwt-Assertion", await accessJwt());
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`/api/admin${path}`, { ...init, headers }, env);
}

async function operator() {
  const signedIn = await testing.signIn(env);
  await env.DB.prepare("update user set role = 'operator' where id = ?")
    .bind(signedIn.user.id)
    .run();
  return signedIn;
}

const setRole = (cookie: string, id: string, role: string | null) =>
  call(`/users/${id}`, cookie, { method: "PATCH", body: JSON.stringify({ role }) });

describe("/api/admin", () => {
  test("needs an Access JWT and an operator session", async () => {
    const regular = await testing.signIn(env);
    const op = await operator();
    expect((await call("/users", op.cookie, {}, false)).status).toBe(403);
    expect((await call("/users", "")).status).toBe(401);
    expect((await call("/users", regular.cookie)).status).toBe(403);
    expect((await call("/users", op.cookie)).status).toBe(200);
  });

  test("lists users and workspaces", async () => {
    const op = await operator();
    const { workspace } = await testing.createWorkspace(env, op.cookie, "Initech", "initech");

    const users = (await (await call("/users", op.cookie)).json()) as {
      users: { id: string; role: string | null; workspaces: number }[];
    };
    expect(users.users.find((user) => user.id === op.user.id)).toMatchObject({
      role: "operator",
      workspaces: 1,
    });

    const workspaces = (await (await call("/workspaces", op.cookie)).json()) as {
      workspaces: { id: string; members: { userId: string; role: string }[] }[];
    };
    expect(workspaces.workspaces.find((w) => w.id === workspace.id)?.members).toEqual([
      expect.objectContaining({ userId: op.user.id, role: "owner" }),
    ]);
  });

  test("grants and revokes operator, but never the caller's own", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const op = await operator();
    const other = await testing.signIn(env);

    expect((await setRole(op.cookie, other.user.id, "operator")).status).toBe(200);
    const row = await env.DB.prepare("select role from user where id = ?")
      .bind(other.user.id)
      .first<{ role: string | null }>();
    expect(row?.role).toBe("operator");
    expect((await setRole(op.cookie, other.user.id, null)).status).toBe(200);

    expect((await setRole(op.cookie, op.user.id, null)).status).toBe(400);
    expect((await setRole(op.cookie, other.user.id, "owner")).status).toBe(400);
    expect((await setRole(op.cookie, "missing", "operator")).status).toBe(404);
  });
});
