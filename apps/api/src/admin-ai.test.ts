import { beforeAll, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";
import { accessEnv, accessJwt } from "./testing-access.ts";

let env: Env;
const run = vi.fn(async () => ({
  answers: { ci: { type: "noul", noul: 0.97 } },
  usage: { input_tokens: 120, output_tokens: 5 },
}));

beforeAll(async () => {
  env = {
    ...(await testing.createTestEnv({ env: { AI: { run } as unknown as Ai } })),
    ...accessEnv,
  };
});

async function call(path: string, cookie: string, method = "GET", body?: object) {
  const headers = new Headers({ cookie, "Cf-Access-Jwt-Assertion": await accessJwt() });
  if (body) headers.set("content-type", "application/json");
  return app.request(
    `/api/admin/ai${path}`,
    { method, headers, body: body && JSON.stringify(body) },
    env,
  );
}

describe("/api/admin/ai", () => {
  test("is for operators only", async () => {
    const regular = await testing.signIn(env);
    expect((await call("", regular.cookie)).status).toBe(403);
    expect((await call("", regular.cookie, "PUT", { enabled: true })).status).toBe(403);
  });

  test("runs a test call once AI is on, and blocks it", async () => {
    const op = await testing.signInOperator(env);
    const { workspace } = await testing.createWorkspace(env, op.cookie, "Acme", "acme-ai");

    const before = (await (await call("", op.cookie)).json()) as {
      binding: boolean;
      settings: { enabled: boolean };
      workspaces: { id: string; setting: unknown }[];
    };
    expect(before.binding).toBe(true);
    expect(before.settings.enabled).toBe(false);
    expect(before.workspaces.find((w) => w.id === workspace.id)?.setting).toBeNull();

    const off = await call("/test", op.cookie, "POST", { workspaceId: workspace.id, text: "CI" });
    expect(((await off.json()) as { result: unknown }).result).toEqual({
      ok: false,
      reason: "off",
    });

    const global = {
      enabled: true,
      features: ["test"],
      workspaceDailyTokens: 1000,
      dailyTokens: 10000,
    };
    expect((await call("", op.cookie, "PUT", global)).status).toBe(200);
    const on = await call("/test", op.cookie, "POST", {
      workspaceId: workspace.id,
      text: "The build failed on lint",
    });
    expect(((await on.json()) as { result: unknown }).result).toEqual({
      ok: true,
      answers: { ci: { type: "noul", noul: 0.97 } },
      cached: false,
    });

    const after = (await (await call("", op.cookie)).json()) as {
      workspaces: {
        id: string;
        offAt: string | null;
        setting: unknown;
        usage: { calls: number; tokensToday: number };
      }[];
    };
    const row = after.workspaces.find((w) => w.id === workspace.id)!;
    expect(row.offAt).toBeNull();
    expect(row.setting).toBeNull();
    expect(row.usage).toMatchObject({ calls: 1, tokensToday: 125 });

    const block = { enabled: false, features: null, dailyTokens: null };
    expect((await call(`/workspaces/${workspace.id}`, op.cookie, "PUT", block)).status).toBe(200);
    const blocked = await call("/test", op.cookie, "POST", {
      workspaceId: workspace.id,
      text: "CI",
    });
    expect(((await blocked.json()) as { result: unknown }).result).toEqual({
      ok: false,
      reason: "off",
    });
  });

  test("rejects unknown features and workspaces", async () => {
    const op = await testing.signInOperator(env);
    const bad = {
      enabled: true,
      features: ["mind_reading"],
      workspaceDailyTokens: 1,
      dailyTokens: 1,
    };
    expect((await call("", op.cookie, "PUT", bad)).status).toBe(400);
    expect(
      (
        await call("/workspaces/nope", op.cookie, "PUT", {
          enabled: true,
          features: null,
          dailyTokens: null,
        })
      ).status,
    ).toBe(404);
  });
});
