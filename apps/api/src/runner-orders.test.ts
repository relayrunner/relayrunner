import { DEFAULT_RUNNER_ORDER } from "@relayrunner/runner-order";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { presentRunnerOrder, resolveRunnerOrder } from "./runner-orders.ts";
import * as testing from "./testing.ts";

let env: Env;
beforeAll(async () => {
  env = await testing.createTestEnv();
});

async function workspace(runnerOrder: string | null = null) {
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(
    env,
    cookie,
    "Acme",
    `acme-${crypto.randomUUID().slice(0, 8)}`,
  );
  await createDb(env.DB)
    .update(schema.workspace)
    .set({ runnerOrder })
    .where(eq(schema.workspace.id, workspace.id));
  return workspace.id;
}

const saved = JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] });

describe("resolveRunnerOrder", () => {
  test("without a saved order, the default order applies", async () => {
    const resolved = await resolveRunnerOrder(createDb(env.DB), await workspace());
    expect(resolved).toEqual({ order: DEFAULT_RUNNER_ORDER, scope: "workspace", stored: null });
  });

  test("a repository's jobs walk the workspace's order", async () => {
    const db = createDb(env.DB);
    const id = await workspace(saved);
    const forWorkspace = await resolveRunnerOrder(db, id);
    const forRepo = await resolveRunnerOrder(db, id, 42);
    expect(forRepo).toEqual(forWorkspace);
    expect(forRepo).toMatchObject({ order: JSON.parse(saved), scope: "workspace", stored: saved });
  });

  test("an unreadable saved order falls back to the default", async () => {
    const resolved = await resolveRunnerOrder(createDb(env.DB), await workspace("{not json"));
    expect(resolved.order).toEqual(DEFAULT_RUNNER_ORDER);
  });
});

describe("presentRunnerOrder", () => {
  test("the default order's version is 'default'", async () => {
    expect(
      await presentRunnerOrder({ order: DEFAULT_RUNNER_ORDER, scope: "workspace", stored: null }),
    ).toEqual({ order: DEFAULT_RUNNER_ORDER, isDefault: true, version: "default" });
  });

  test("a saved order's version changes with the order", async () => {
    const order = JSON.parse(saved);
    const a = await presentRunnerOrder({ order, scope: "workspace", stored: saved });
    const b = await presentRunnerOrder({
      order,
      scope: "workspace",
      stored: JSON.stringify({ steps: [{ key: "github" }] }),
    });
    expect(a).toMatchObject({ isDefault: false });
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(a.version).not.toBe(b.version);
  });
});
