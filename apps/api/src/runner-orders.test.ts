import { DEFAULT_RUNNER_ORDER } from "@relayrunner/runner-order";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { presentRunnerOrder, resolveRunnerOrder } from "./runner-orders.ts";
import * as testing from "./testing.ts";

// Who can push to which repo on GitHub, by repo full name and GitHub user id.
const pushers = new Map<string, Set<number>>();
vi.mock("./github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
  userCanWriteRepo: async (_token: string, repo: string, userId: number) =>
    pushers.get(repo)?.has(userId) ?? false,
}));

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

  test("a repository with its own order walks it; others walk the workspace's", async () => {
    const db = createDb(env.DB);
    const id = await workspace(saved);
    const own = JSON.stringify({ steps: [{ key: "github" }] });
    await db.insert(schema.repoRunnerOrder).values({
      workspaceId: id,
      repositoryId: 42,
      repository: "acme/api",
      runnerOrder: own,
      updatedAt: new Date(),
    });
    expect(await resolveRunnerOrder(db, id, 42)).toEqual({
      order: JSON.parse(own),
      scope: "repository",
      stored: own,
    });
    expect(await resolveRunnerOrder(db, id, 43)).toMatchObject({
      scope: "workspace",
      stored: saved,
    });
    expect(await resolveRunnerOrder(db, id)).toMatchObject({ scope: "workspace", stored: saved });
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
    ).toEqual({
      order: DEFAULT_RUNNER_ORDER,
      scope: "workspace",
      isDefault: true,
      version: "default",
    });
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
    // The same steps as a repository's own order are a different version.
    const own = await presentRunnerOrder({ order, scope: "repository", stored: saved });
    expect(own.version).not.toBe(a.version);
  });
});

describe("a repo's own order through the API", () => {
  const send = (path: string, cookie: string, method: string, body?: unknown) =>
    testing.call(env, path, cookie, body, method);

  async function setup() {
    const { cookie } = await testing.signIn(env);
    const { workspace, cookie: owner } = await testing.createWorkspace(
      env,
      cookie,
      "Repos",
      `repos-${crypto.randomUUID().slice(0, 8)}`,
    );
    const suffix = crypto.randomUUID().slice(0, 8);
    const repos = [
      { id: Math.floor(Math.random() * 1e9), fullName: `acme/api-${suffix}` },
      { id: Math.floor(Math.random() * 1e9), fullName: `acme/web-${suffix}` },
    ];
    await createDb(env.DB)
      .insert(schema.githubRepository)
      .values(
        repos.map((repo) => ({
          ...repo,
          installationId: workspace.installationId,
          private: true,
          githubStateAt: new Date(),
        })),
      );
    const order = (repo?: string) =>
      `/workspaces/${workspace.id}/runner-order${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
    return { workspace, owner, repos, order };
  }

  const events = async (workspaceId: string) =>
    (
      await env.DB.prepare(
        "select type, data from activity_event where workspace_id = ? and type like 'settings.runner_order%' order by id",
      )
        .bind(workspaceId)
        .all<{ type: string; data: string }>()
    ).results.map((row) => ({ type: row.type, data: JSON.parse(row.data) }));

  test("a repo gets its own order, keeps it through workspace changes, and goes back", async () => {
    const { workspace, owner, repos, order } = await setup();
    const [api, web] = repos;

    // Inherited: the workspace's order, in its scope.
    const inherited = (await (await send(order(api.fullName), owner, "GET")).json()) as {
      version: string;
    };
    expect(inherited).toMatchObject({
      order: DEFAULT_RUNNER_ORDER,
      scope: "workspace",
      repository: api.fullName,
    });

    // Taking the workspace's steps as its own still saves them.
    const copied = await send(order(api.fullName.toUpperCase()), owner, "PUT", {
      ...DEFAULT_RUNNER_ORDER,
      version: inherited.version,
    });
    expect(copied.status).toBe(200);
    expect(await copied.json()).toMatchObject({ scope: "repository", repository: api.fullName });

    const steps = [{ key: "github" }];
    expect((await send(order(api.fullName), owner, "PUT", { steps })).status).toBe(200);
    // The workspace's order changes; the repo keeps its own, and the other repo follows.
    expect((await send(order(), owner, "PUT", { steps: [{ key: "machine" }] })).status).toBe(200);
    expect(await (await send(order(api.fullName), owner, "GET")).json()).toMatchObject({
      order: { steps },
      scope: "repository",
    });
    expect(await (await send(order(web.fullName), owner, "GET")).json()).toMatchObject({
      order: { steps: [{ key: "machine" }] },
      scope: "workspace",
    });
    expect(await (await send(order(), owner, "GET")).json()).toMatchObject({
      scope: "workspace",
      ownOrders: [{ repositoryId: api.id, repository: api.fullName }],
    });

    const back = await send(order(api.fullName), owner, "DELETE");
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({
      order: { steps: [{ key: "machine" }] },
      scope: "workspace",
      previous: { steps },
    });
    expect(await (await send(order(), owner, "GET")).json()).toMatchObject({ ownOrders: [] });
    // Again: nothing to remove, nothing logged.
    expect((await send(order(api.fullName), owner, "DELETE")).status).toBe(200);

    expect(await events(workspace.id)).toEqual([
      {
        type: "settings.runner_order",
        data: expect.objectContaining({
          repository: api.fullName,
          steps: DEFAULT_RUNNER_ORDER.steps,
        }),
      },
      {
        type: "settings.runner_order",
        data: expect.objectContaining({ repository: api.fullName, steps }),
      },
      {
        type: "settings.runner_order",
        data: expect.not.objectContaining({ repository: expect.anything() }),
      },
      {
        type: "settings.runner_order_removed",
        data: expect.objectContaining({ repository: api.fullName }),
      },
    ]);
  });

  test("anyone who can push to a repo may set its order, but not the workspace's", async () => {
    const { workspace, repos, order } = await setup();
    const [api, web] = repos;
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    pushers.set(api.fullName, new Set([member.githubId]));
    const steps = [{ key: "github" }];

    expect((await send(order(api.fullName), member.cookie, "PUT", { steps })).status).toBe(200);
    expect((await send(order(api.fullName), member.cookie, "DELETE")).status).toBe(200);
    const refused = await send(order(web.fullName), member.cookie, "PUT", { steps });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect((await send(order(web.fullName), member.cookie, "DELETE")).status).toBe(403);
    expect((await send(order(), member.cookie, "PUT", { steps })).status).toBe(403);
  });

  test("a repo outside the workspace is not found, and a DELETE must name one", async () => {
    const { owner, order } = await setup();
    expect((await send(order("someone/else"), owner, "GET")).status).toBe(404);
    expect(
      (await send(order("someone/else"), owner, "PUT", { steps: [{ key: "github" }] })).status,
    ).toBe(404);
    expect((await send(order(), owner, "DELETE")).status).toBe(400);
  });
});
