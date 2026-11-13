import { relayInputs } from "@relayrunner/runner-order";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../env.ts";
import { createTestEnv } from "../testing.ts";

// The Router runs here without the Workers runtime: a plain object stands in for its state.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const { Router } = await import("./router.ts");

function memoryState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const clone = <T>(value: T): T => structuredClone(value);
  const storage = {
    get: async (key: string) => clone(data.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") data.set(key, clone(value));
      else for (const [k, v] of Object.entries(key)) data.set(k, clone(v));
    },
    delete: async (keys: string | string[]) => {
      for (const key of [keys].flat()) data.delete(key);
    },
    list: async ({ prefix = "", limit = Infinity }: { prefix?: string; limit?: number } = {}) =>
      new Map(
        [...data]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit)
          .map(([key, value]) => [key, clone(value)]),
      ),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAll: async () => data.clear(),
  };
  return {
    data,
    alarm: () => alarm,
    ctx: { storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn() },
  };
}

const owner = { id: 500, login: "leonel" };
const job = (runId: number) => ({
  workspaceId: "w1",
  installationId: 7,
  repositoryId: 1,
  repo: "leonel/cabal",
  runId,
  private: true,
  ...relayInputs({ machine: ["self-hosted"] }),
  startedBy: owner,
  triggeredBy: owner,
});
const queued = (runId: number, jobId: number) => ({ jobId, repositoryId: 1, runId });

describe("Router: jobs wait for a full machine", () => {
  let env: Env;
  let state: ReturnType<typeof memoryState>;
  let router: InstanceType<typeof Router>;
  // ci-runner: one slot, in use until a test frees it.
  let running: number;
  const run = vi.fn(async (_work: { route: Record<string, unknown> }) => "sent");

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    running = 1;
    run.mockClear();
    const testEnv = await createTestEnv();
    const now = Date.now();
    for (const sql of [
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (7, 10, 'leonel', 'User', ?1, ?1)",
      "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 7, 'W', 'w', ?1)",
      "insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'Leonel', 'l@example.com', 1, ?1, ?1)",
      "insert into account (id, account_id, provider_id, user_id, created_at, updated_at) values ('a1', '500', 'github', 'u1', ?1, ?1)",
      "insert into machine (id, workspace_id, user_id, name, os, arch, token_hash, source, sharing, created_at, updated_at) values ('m1', 'w1', 'u1', 'ci-runner', 'linux', 'x64', 'hash', 'connect', 'only_me', ?1, ?1)",
    ])
      await testEnv.DB.prepare(sql).bind(now).run();
    env = {
      ...testEnv,
      MACHINE_LINK: {
        getByName: () => ({
          status: async () => ({
            online: true,
            state: running ? "busy" : "idle",
            connectedAt: now,
            slots: 1,
            running,
          }),
          reserve: async () => running < 1,
          run,
        }),
      },
    } as unknown as Env;
    state = memoryState();
    router = new Router(state.ctx as never, env);
  });

  test("a full machine with no fallback answers a route label instead of failing", async () => {
    const decision = await router.route(job(1));
    expect(decision).toMatchObject({ step: "machine", skipped: [], notInOrder: [] });
    expect(decision.runner).toMatch(/^rr-[0-9a-f]{12}$/);
    expect([...state.data.keys()]).toEqual([`wait:${decision.runner!.slice(3)}`]);
    expect(state.alarm()).not.toBeNull();
  });

  test("the queued job goes to the machine once a slot frees, under the label it waited on", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    expect(await router.claim(routeId, queued(1, 42))).toBe("waiting");
    expect(run).not.toHaveBeenCalled();
    running = 0;
    await router.alarm();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]).toEqual([
      {
        route: expect.objectContaining({
          id: routeId,
          machineId: "m1",
          state: "dispatched",
          jobId: 42,
        }),
        workspaceId: "w1",
      },
    ]);
    expect(state.data.has(`wait:${routeId}`)).toBe(false);
  });

  test("a slot that frees before the job is queued holds the route for it", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    running = 0;
    await router.alarm();
    expect(run).not.toHaveBeenCalled();
    // The usual hand-off from here: the queued webhook claims the route.
    expect(await router.claim(routeId, queued(1, 42))).toMatchObject({
      id: routeId,
      machineId: "m1",
      state: "dispatched",
    });
  });

  test("first in line gets the next slot, ahead of a new pick", async () => {
    const first = (await router.route(job(1))).runner!.slice(3);
    const second = (await router.route(job(2))).runner!.slice(3);
    await router.claim(first, queued(1, 41));
    await router.claim(second, queued(2, 42));
    running = 0;
    const third = await router.route(job(3));
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].route).toMatchObject({ id: first, jobId: 41 });
    // The second still waits, and the new pick waits behind it.
    expect(third.runner).toMatch(/^rr-/);
    expect(state.data.has(`wait:${second}`)).toBe(true);
    expect(state.data.has(`wait:${third.runner!.slice(3)}`)).toBe(true);
    // The first job's end frees the slot for the second.
    await router.release(first);
    await router.alarm();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].route).toMatchObject({ id: second, jobId: 42 });
  });

  test("a job that ends while it waits leaves the line", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    await router.claim(routeId, queued(1, 42));
    // Another run's job can't take it out.
    await router.dropWaiting(routeId, queued(2, 43));
    expect(state.data.has(`wait:${routeId}`)).toBe(true);
    await router.dropWaiting(routeId, queued(1, 42));
    expect(state.data.has(`wait:${routeId}`)).toBe(false);
    running = 0;
    await router.alarm();
    expect(run).not.toHaveBeenCalled();
  });

  test("a re-run of failed jobs on its old label waits for a full machine too", async () => {
    const now = Date.now();
    for (const sql of [
      "insert into github_repository (id, installation_id, full_name, private, github_state_at, created_at, updated_at) values (1, 7, 'leonel/cabal', 1, ?1, ?1, ?1)",
      "insert into route_decision (workspace_id, repository_id, run_id, run_attempt, step, runner, skipped, not_in_order, machine, github, hosted, started_by_id, started_by_login, triggered_by_id, triggered_by_login, created_at) values ('w1', 1, 5, 1, 'machine', 'rr-0123456789ab', '[]', '[]', '[\"self-hosted\"]', '[]', '{}', 500, 'leonel', 500, 'leonel', ?1)",
      "insert into workflow_run (id, run_attempt, installation_id, repository_id, repository_full_name, event, started_by_id, started_by_login, triggered_by_id, triggered_by_login, head_sha, status, github_updated_at, created_at, updated_at) values (5, 2, 7, 1, 'leonel/cabal', 'push', 500, 'leonel', 500, 'leonel', 'abc', 'in_progress', ?1, ?1, ?1)",
    ])
      await env.DB.prepare(sql).bind(now).run();
    const rerun = {
      ...queued(5, 77),
      runAttempt: 2,
      workspaceId: "w1",
      installationId: 7,
      repo: "leonel/cabal",
    };
    expect(await router.reroute("0123456789ab", rerun)).toBe("waiting");
    // A redelivered `queued` webhook finds it in line.
    expect(await router.claim("0123456789ab", queued(5, 77))).toBe("waiting");
    running = 0;
    await router.alarm();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].route).toMatchObject({
      id: "0123456789ab",
      jobId: 77,
      runAttempt: 2,
      state: "dispatched",
    });
  });

  test("another run's job can't claim a waiting label", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    expect(await router.claim(routeId, queued(2, 42))).toBeNull();
  });
});
