import { relayInputs } from "@relayrunner/runner-order";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../env.ts";
import { createTestEnv } from "../testing.ts";

// GitHub reads the Router makes itself: tests that need them set the answers.
const github = vi.hoisted(() => ({
  userCanReadRepo: vi.fn(),
  listRunners: vi.fn(),
  orgAppSlugs: vi.fn(),
}));
vi.mock("../github/github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github/github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
  orgAppSlugs: github.orgAppSlugs,
}));
vi.mock("../github/repos-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github/repos-api.ts")>()),
  userCanReadRepo: github.userCanReadRepo,
}));
vi.mock("../github/runners-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github/runners-api.ts")>()),
  listRunners: github.listRunners,
}));

const { Router } = await import("./router.ts");
const { GitHubRateLimitError } = await import("../github/github-api.ts");

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
  const setWaiting = vi.fn(
    async (_workspaceId: string, _jobs: { repo: string; since: number }[]) => {},
  );
  const spilled = vi.fn(async (_at: number) => {});
  // How many jobs the machine was told wait on it, in order.
  const counts = () => setWaiting.mock.calls.map(([workspace, jobs]) => [workspace, jobs.length]);

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    running = 1;
    run.mockClear();
    setWaiting.mockClear();
    spilled.mockClear();
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
          setWaiting,
          spilled,
        }),
      },
    } as unknown as Env;
    state = memoryState();
    router = new Router(state.ctx as never, env);
  });

  test("the busy machine hears how many jobs wait for it, and when none do", async () => {
    const first = (await router.route(job(1))).runner!.slice(3);
    await router.route(job(2));
    await router.alarm();
    // The second pick drains the line first, with one job in it.
    expect(counts()).toEqual([
      ["w1", 1],
      ["w1", 2],
    ]);
    expect(setWaiting.mock.calls[1]![1].map((queued) => queued.repo)).toEqual([
      "leonel/cabal",
      "leonel/cabal",
    ]);
    // Unchanged: nothing more to say.
    await router.alarm();
    expect(setWaiting).toHaveBeenCalledTimes(2);
    await router.claim(first, queued(1, 41));
    running = 0;
    await router.alarm();
    expect(run).toHaveBeenCalledOnce();
    expect(counts().at(-1)).toEqual(["w1", 1]);
    // The last one ends while it waits.
    const [second] = [...state.data.keys()].filter((key) => key.startsWith("wait:"));
    running = 1;
    await router.dropWaiting(second!.slice(5), queued(2, 42));
    await router.alarm();
    expect(counts().at(-1)).toEqual(["w1", 0]);
  });

  test("a waiting job is named in the queue once its queued webhook says which job it is", async () => {
    await env.DB.prepare(
      `insert into job_timing (id, installation_id, repository_id, repository_full_name, run_id,
        run_attempt, workflow_name, name, labels, created_at, updated_at)
        values (42, 7, 1, 'leonel/cabal', 2, 1, 'CI', 'test', '[]', ?1, ?1)`,
    )
      .bind(Date.now())
      .run();
    await router.route(job(1));
    const waiting = (await router.route(job(2))).runner!.slice(3);
    await router.alarm();
    expect(setWaiting.mock.calls.at(-1)![1]).toEqual([
      { repo: "leonel/cabal", since: expect.any(Number) },
      { repo: "leonel/cabal", since: expect.any(Number) },
    ]);
    expect(await router.claim(waiting, queued(2, 42))).toBe("waiting");
    expect(setWaiting.mock.calls.at(-1)![1]).toEqual([
      { repo: "leonel/cabal", since: expect.any(Number) },
      { repo: "leonel/cabal", since: expect.any(Number), name: "test", workflow: "CI" },
    ]);
  });

  test("a full machine hears when a job that fit it went to GitHub instead", async () => {
    const decision = await router.route({
      ...job(1),
      ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
    });
    expect(decision).toMatchObject({ step: "github", runner: "ubuntu-latest" });
    expect(spilled).toHaveBeenCalledOnce();
    running = 0;
    await router.route({
      ...job(2),
      ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
    });
    expect(spilled).toHaveBeenCalledOnce();
  });

  test("each routing decision logs one routing.decision line with what charts group by", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const decisions = () =>
      info.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .filter((line) => line.event === "routing.decision");
    await router.route({
      ...job(1),
      ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
    });
    const waited = await router.route(job(2));
    expect(decisions()).toMatchObject([
      {
        level: "info",
        service: "api",
        result: "routed",
        step: "github",
        runnerKind: "github",
        runner: "ubuntu-latest",
        skipped: ["machine:machine_full"],
        workspaceId: "w1",
        installationId: 7,
        repo: "leonel/cabal",
        runId: 1,
      },
      {
        result: "waiting",
        step: "machine",
        runnerKind: "machine",
        reason: "machine_full",
        routeId: waited.runner!.slice(3),
        runId: 2,
      },
    ]);
    expect(decisions()[1]).not.toHaveProperty("runner");
    expect(decisions()[0].decideMs).toBeTypeOf("number");
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

  test("a job waiting for a busy machine keeps waiting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const routeId = (await router.route(job(1))).runner!.slice(3);
      await router.claim(routeId, queued(1, 42));
      await router.alarm();
      vi.advanceTimersByTime(60 * 60_000);
      await router.alarm();
      expect(state.data.has(`wait:${routeId}`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("another run's job can't claim a waiting label", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    expect(await router.claim(routeId, queued(2, 42))).toBeNull();
  });

  test("holds a job waiting for a full machine, and a live route its job claimed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Waiting for the full machine: still the Router's, before and after its queued webhook.
      const waiting = (await router.route(job(1))).runner!.slice(3);
      expect(await router.holds(waiting, queued(1, 42))).toBe(true);
      await router.claim(waiting, queued(1, 42));
      expect(await router.holds(waiting, queued(1, 42))).toBe(true);
      // Not for another job of the run, or another run's.
      expect(await router.holds(waiting, queued(1, 43))).toBe(false);
      expect(await router.holds(waiting, queued(2, 42))).toBe(false);
      await router.dropWaiting(waiting, queued(1, 42));
      expect(await router.holds(waiting, queued(1, 42))).toBe(false);

      running = 0;
      const routed = (await router.route(job(3))).runner!.slice(3);
      await router.claim(routed, queued(3, 44));
      expect(await router.holds(routed, queued(3, 44))).toBe(true);
      expect(await router.holds(routed, queued(3, 45))).toBe(false);
      // Past a day the route is gone.
      vi.advanceTimersByTime(25 * 60 * 60_000);
      expect(await router.holds(routed, queued(3, 44))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("doesn't hold a job whose route is done or unknown", async () => {
    running = 0;
    const routeId = (await router.route(job(1))).runner!.slice(3);
    await router.claim(routeId, queued(1, 42));
    await router.release(routeId);
    expect(await router.holds(routeId, queued(1, 42))).toBe(false);
    expect(await router.holds("0123456789ab", queued(1, 42))).toBe(false);
  });
});

describe("Router: GitHub's API limit", () => {
  let router: InstanceType<typeof Router>;
  // Started by someone other than the machine's owner, so a machine shared with anyone needs to
  // know its owner can read the repo.
  const someoneElse = { id: 501, login: "atticus" };
  const othersJob = (machine: string[]) => ({
    ...job(1),
    ...relayInputs({ machine }),
    startedBy: someoneElse,
    triggeredBy: someoneElse,
  });

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    github.userCanReadRepo.mockReset();
    const testEnv = await createTestEnv();
    const now = Date.now();
    for (const sql of [
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (7, 10, 'leonel', 'User', ?1, ?1)",
      "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 7, 'W', 'w', ?1)",
      "insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'Leonel', 'l@example.com', 1, ?1, ?1)",
      "insert into account (id, account_id, provider_id, user_id, created_at, updated_at) values ('a1', '500', 'github', 'u1', ?1, ?1)",
      "insert into machine (id, workspace_id, user_id, name, os, arch, token_hash, source, sharing, created_at, updated_at) values ('m1', 'w1', 'u1', 'ci-runner', 'linux', 'x64', 'hash', 'connect', 'anyone', ?1, ?1)",
    ])
      await testEnv.DB.prepare(sql).bind(now).run();
    const env = {
      ...testEnv,
      MACHINE_LINK: {
        getByName: () => ({
          status: async () => ({
            online: true,
            state: "idle",
            connectedAt: now,
            slots: 1,
            running: 0,
          }),
          reserve: async () => true,
        }),
      },
    } as unknown as Env;
    router = new Router(memoryState().ctx as never, env);
  });

  test("a machine kept out by the limit says so, instead of no idle machine", async () => {
    github.userCanReadRepo.mockRejectedValue(
      new GitHubRateLimitError("GET /user/500 failed with 403"),
    );
    const decision = await router.route(othersJob(["self-hosted"]));
    expect(decision.runner).toBeNull();
    expect(decision.skipped).toContainEqual({ key: "machine", reason: "github_rate_limited" });
  });

  test("other GitHub failures still read as no idle machine", async () => {
    github.userCanReadRepo.mockRejectedValue(new Error("GET /user/500 failed with 502"));
    const decision = await router.route(othersJob(["self-hosted"]));
    expect(decision.skipped).toContainEqual({ key: "machine", reason: "no_machine" });
  });

  test("GitHub isn't asked about a machine without the job's labels", async () => {
    github.userCanReadRepo.mockResolvedValue(true);
    const decision = await router.route(othersJob(["self-hosted", "gpu"]));
    expect(github.userCanReadRepo).not.toHaveBeenCalled();
    expect(decision.skipped).toContainEqual({ key: "machine", reason: "no_machine" });
  });

  test("an owner who can read the repo still gets the job", async () => {
    github.userCanReadRepo.mockResolvedValue(true);
    const decision = await router.route(othersJob(["self-hosted"]));
    expect(decision.runner).toMatch(/^rr-/);
  });
});

describe("Router: runners added from a repo", () => {
  let router: InstanceType<typeof Router>;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const env = await createTestEnv();
    const now = Date.now();
    for (const sql of [
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (7, 10, 'leonel', 'User', ?1, ?1)",
      "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 7, 'W', 'w', ?1)",
      // Registered on leonel/cabal (repository id 1).
      `insert into machine (id, workspace_id, name, os, arch, source, sharing, installation_id, github_runner_id, github_repository_id, routing_label, github_labels, created_at, updated_at) values ('gh1', 'w1', 'mighty-m1', 'macos', 'arm64', 'github', 'anyone', 7, 21, 1, 'rr-runner-0a1b2c3d', '["self-hosted","macOS","ARM64","rr-runner-0a1b2c3d"]', ?1, ?1)`,
    ])
      await env.DB.prepare(sql).bind(now).run();
    github.listRunners.mockReset().mockResolvedValue([
      {
        id: 21,
        name: "mighty-m1",
        os: "macOS",
        status: "online",
        busy: false,
        ephemeral: false,
        labels: ["self-hosted", "macOS", "ARM64", "rr-runner-0a1b2c3d"],
      },
    ]);
    router = new Router(memoryState().ctx as never, env);
  });

  test("its own repo's job goes to it, by its routing label", async () => {
    const decision = await router.route(job(1));
    expect(decision.runner).toBe("rr-runner-0a1b2c3d");
    expect(github.listRunners).toHaveBeenCalledWith("ghs_test", {
      kind: "repo",
      repo: "leonel/cabal",
    });
  });

  test("another repo's job never goes to it", async () => {
    const decision = await router.route({ ...job(2), repositoryId: 2, repo: "leonel/other" });
    expect(decision.runner).toBeNull();
    expect(decision.skipped).toContainEqual({ key: "machine", reason: "no_machine" });
    expect(github.listRunners).not.toHaveBeenCalled();
  });
});

describe("Router: a machine that goes offline after the pick", () => {
  let env: Env;
  let state: ReturnType<typeof memoryState>;
  let router: InstanceType<typeof Router>;
  let online: boolean;
  const run = vi.fn(async (_work: { route: Record<string, unknown> }) =>
    online ? "sent" : "offline",
  );
  const dropHold = vi.fn();
  const endJob = vi.fn();

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    online = true;
    run.mockClear();
    dropHold.mockClear();
    endJob.mockClear();
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
          status: async () =>
            online
              ? { online: true, state: "idle", connectedAt: now, slots: 1, running: 0 }
              : { online: false, state: null, connectedAt: null, slots: 1, running: 0 },
          reserve: async () => online,
          run,
          dropHold,
        }),
      },
      STRANDED_JOB: { getByName: () => ({ start: endJob }) },
    } as unknown as Env;
    state = memoryState();
    router = new Router(state.ctx as never, env);
  });

  test("the job waits in line and goes out once the machine is back", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    expect(await router.claim(routeId, queued(1, 42))).toMatchObject({ state: "dispatched" });
    // The hand-off found the machine gone.
    online = false;
    await router.requeue(routeId);
    expect(state.data.has(`route:${routeId}`)).toBe(false);
    expect(state.data.get(`wait:${routeId}`)).toMatchObject({ jobId: 42 });
    expect(dropHold).toHaveBeenCalledWith(routeId);
    expect(run).not.toHaveBeenCalled();
    online = true;
    await router.alarm();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].route).toMatchObject({ id: routeId, jobId: 42 });
    expect(state.data.has(`wait:${routeId}`)).toBe(false);
  });

  test("a waiting job sent to a machine that just went offline stays in line", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    await router.claim(routeId, queued(1, 42));
    online = false;
    await router.requeue(routeId);
    // The machine looks online again, but its socket is gone by the time the job is sent.
    online = true;
    run.mockResolvedValueOnce("offline");
    await router.alarm();
    expect(state.data.get(`wait:${routeId}`)).toMatchObject({ jobId: 42 });
    await router.alarm();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].route).toMatchObject({ id: routeId, jobId: 42 });
  });

  test("a route that's unclaimed, done or unknown is left alone", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    // No job has claimed it yet, so there's nothing to put back.
    await router.requeue(routeId);
    expect(state.data.has(`route:${routeId}`)).toBe(true);
    await router.claim(routeId, queued(1, 42));
    await router.release(routeId);
    await router.requeue(routeId);
    await router.requeue("ffffffffffff");
    expect([...state.data.keys()].some((key) => key.startsWith("wait:"))).toBe(false);
    expect(dropHold).not.toHaveBeenCalled();
  });

  test("a job sent but never started goes back in line and out again", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    await router.claim(routeId, queued(1, 42));
    // The machine said its runner failed. Another machine's report changes nothing.
    await router.requeueSent(routeId, 42, "m2");
    expect(run).not.toHaveBeenCalled();
    await router.requeueSent(routeId, 42, "m1");
    expect(dropHold).toHaveBeenCalledWith(routeId);
    // The machine it failed on goes last, but it's the only one.
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].route).toMatchObject({ id: routeId, jobId: 42, requeues: 1 });
  });

  test("a job whose runner keeps failing ends after three tries", async () => {
    const routeId = (await router.route(job(1))).runner!.slice(3);
    await router.claim(routeId, queued(1, 42));
    for (let i = 0; i < 3; i++) await router.requeueSent(routeId, 42, "m1");
    expect(run).toHaveBeenCalledTimes(2);
    expect(endJob).toHaveBeenCalledWith({
      routeId,
      jobId: 42,
      installationId: 7,
      repo: "leonel/cabal",
      reason: "runner_failed",
    });
    expect([...state.data.keys()].filter((key) => key.includes(routeId))).toEqual([]);
  });

  test("a job with no machine online ends after 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const routeId = (await router.route(job(1))).runner!.slice(3);
      await router.claim(routeId, queued(1, 42));
      online = false;
      await router.requeue(routeId);
      await router.alarm();
      vi.advanceTimersByTime(4 * 60_000);
      await router.alarm();
      expect(endJob).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      await router.alarm();
      expect(endJob).toHaveBeenCalledWith(
        expect.objectContaining({ routeId, reason: "no_machine" }),
      );
      expect(state.data.has(`wait:${routeId}`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // A run whose first attempt had two relays, each routing its own job to its own label.
  // `startedBy`: who started the run. `recorded`: whether the re-run attempt's workflow_run (who
  // re-ran it) has come yet; the run's starter re-ran it.
  async function twoPicks(secondMachine = "self-hosted", recorded = true, startedBy = owner) {
    const now = Date.now();
    const decision = (pickJobId: string, runner: string, machine: string) =>
      `insert into route_decision (workspace_id, repository_id, run_id, run_attempt, pick_job_id, step, runner, skipped, not_in_order, machine, github, hosted, started_by_id, started_by_login, triggered_by_id, triggered_by_login, created_at) values ('w1', 1, 5, 1, '${pickJobId}', 'machine', '${runner}', '[]', '[]', '["${machine}"]', '[]', '{}', ?2, ?3, ?2, ?3, ?1)`;
    await env.DB.prepare(
      "insert into github_repository (id, installation_id, full_name, private, github_state_at, created_at, updated_at) values (1, 7, 'leonel/cabal', 1, ?1, ?1, ?1)",
    )
      .bind(now)
      .run();
    for (const sql of [
      decision("relay-a", "rr-aaaaaaaaaaaa", "self-hosted"),
      decision("relay-b", "rr-bbbbbbbbbbbb", secondMachine),
    ])
      await env.DB.prepare(sql).bind(now, startedBy.id, startedBy.login).run();
    if (recorded) await rerunBy(startedBy, startedBy);
  }
  // The re-run attempt's workflow_run: `startedBy` started the run, `by` re-ran it.
  async function rerunBy(by: { id: number; login: string }, startedBy = owner) {
    await env.DB.prepare(
      "insert into workflow_run (id, run_attempt, installation_id, repository_id, repository_full_name, event, started_by_id, started_by_login, triggered_by_id, triggered_by_login, head_sha, status, github_updated_at, created_at, updated_at) values (5, 2, 7, 1, 'leonel/cabal', 'push', ?4, ?5, ?2, ?3, 'abc', 'in_progress', ?1, ?1, ?1)",
    )
      .bind(Date.now(), by.id, by.login, startedBy.id, startedBy.login)
      .run();
  }
  const teammate = { id: 600, login: "sofia" };
  const rerun = {
    ...queued(5, 77),
    runAttempt: 2,
    workspaceId: "w1",
    installationId: 7,
    repo: "leonel/cabal",
  };
  const routedAgain = {
    id: "bbbbbbbbbbbb",
    machineId: "m1",
    jobId: 77,
    runAttempt: 2,
    state: "dispatched",
  };

  test("a re-run of the job the second relay routed goes to a machine again", async () => {
    await twoPicks();
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toMatchObject({
      id: "bbbbbbbbbbbb",
      machineId: "m1",
      jobId: 77,
      runAttempt: 2,
      state: "dispatched",
    });
  });

  test("a re-run whose machine is offline waits for it, then ends after 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await twoPicks();
      online = false;
      expect(await router.reroute("bbbbbbbbbbbb", rerun)).toBe("waiting");
      expect(state.data.get("wait:bbbbbbbbbbbb")).toMatchObject({ jobId: 77, runAttempt: 2 });
      await router.alarm();
      vi.advanceTimersByTime(5 * 60_000);
      await router.alarm();
      expect(endJob).toHaveBeenCalledWith(
        expect.objectContaining({ routeId: "bbbbbbbbbbbb", jobId: 77, reason: "no_machine" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a re-run whose machine is back in time takes it", async () => {
    await twoPicks();
    online = false;
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toBe("waiting");
    online = true;
    await router.alarm();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].route).toMatchObject({ id: "bbbbbbbbbbbb", jobId: 77 });
    expect(endJob).not.toHaveBeenCalled();
  });

  test("a teammate's re-run of the owner's run goes to the owner's only_me machine", async () => {
    // Before this attempt's workflow_run says who re-ran it: the run's starter is enough.
    await twoPicks("self-hosted", false);
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toMatchObject(routedAgain);
    expect(state.data.has("wait:bbbbbbbbbbbb")).toBe(false);
  });

  test("so does one whose workflow_run already says the teammate re-ran it", async () => {
    await twoPicks("self-hosted", false);
    await rerunBy(teammate);
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toMatchObject(routedAgain);
  });

  test("a teammate's re-run that waited for the owner's offline machine takes it once it's back", async () => {
    await twoPicks("self-hosted", false);
    online = false;
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toBe("waiting");
    online = true;
    await router.alarm();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].route).toMatchObject({ id: "bbbbbbbbbbbb", jobId: 77 });
    expect(state.data.has("wait:bbbbbbbbbbbb")).toBe(false);
    expect(endJob).not.toHaveBeenCalled();
  });

  test("a re-run of a run a teammate started is refused by an only_me machine", async () => {
    // Even when the machine's owner re-ran it, before or after its workflow_run comes.
    await twoPicks("self-hosted", false, teammate);
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toBeNull();
    await rerunBy(owner, teammate);
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toBeNull();
    expect(state.data.has("wait:bbbbbbbbbbbb")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("a re-run no machine's labels fit is refused before its workflow_run comes too", async () => {
    await twoPicks("gpu", false);
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toBeNull();
    expect(state.data.has("wait:bbbbbbbbbbbb")).toBe(false);
  });

  test("Re-run all jobs: a teammate's pick at attempt 2 of the owner's run gets the only_me machine", async () => {
    const decision = await router.route({ ...job(9), triggeredBy: teammate, runAttempt: 2 });
    expect(decision.runner).toMatch(/^rr-/);
  });

  test("a teammate's first attempt of the owner's run still isn't the owner's", async () => {
    for (const runAttempt of [undefined, 1]) {
      const decision = await router.route({ ...job(9), triggeredBy: teammate, runAttempt });
      expect(decision.runner).toBeNull();
      expect(decision.skipped).toContainEqual(
        expect.objectContaining({ key: "machine", reason: "machine_not_shared" }),
      );
    }
  });

  test("a re-run no machine's labels fit, or on a label no pick of the run answered, is refused", async () => {
    await twoPicks("gpu");
    expect(await router.reroute("bbbbbbbbbbbb", rerun)).toBeNull();
    expect(await router.reroute("cccccccccccc", rerun)).toBeNull();
    expect([...state.data.keys()].some((key) => key.startsWith("wait:"))).toBe(false);
  });

  test("a machine back in time takes the job", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const routeId = (await router.route(job(1))).runner!.slice(3);
      await router.claim(routeId, queued(1, 42));
      online = false;
      await router.requeue(routeId);
      await router.alarm();
      vi.advanceTimersByTime(4 * 60_000);
      online = true;
      await router.alarm();
      expect(run).toHaveBeenCalledOnce();
      expect(endJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Router: hosted providers that can't see the repo", () => {
  let router: InstanceType<typeof Router>;
  const groundboxJob = {
    ...job(1),
    ...relayInputs({ groundbox: ["groundbox-2vcpu"], github: ["ubuntu-latest"] }),
  };

  let env: Awaited<ReturnType<typeof createTestEnv>>;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    env = await createTestEnv();
    const now = Date.now();
    for (const sql of [
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (7, 10, 'acme', 'Organization', ?1, ?1)",
      `insert into workspace (id, installation_id, name, slug, runner_order, created_at) values ('w1', 7, 'W', 'w', '{"steps":[{"key":"groundbox"},{"key":"github"}]}', ?1)`,
    ])
      await env.DB.prepare(sql).bind(now).run();
    github.orgAppSlugs.mockReset().mockResolvedValue(["groundbox-dev"]);
    router = new Router(memoryState().ctx as never, env as unknown as Env);
  });

  test("a provider whose App isn't installed on the org is skipped", async () => {
    github.orgAppSlugs.mockResolvedValue(["blacksmith-sh"]);
    const decision = await router.route(groundboxJob);
    expect(decision).toMatchObject({
      runner: "ubuntu-latest",
      skipped: [
        { key: "groundbox", reason: "provider_no_access", access: { cause: "not_installed" } },
      ],
    });
  });

  test("GitHub not saying which Apps are installed never skips one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    github.orgAppSlugs.mockRejectedValue(new Error("GET /orgs/acme/installations failed with 403"));
    expect((await router.route(groundboxJob)).runner).toBe("groundbox-2vcpu");
  });

  test("a repo with its own order walks it; the rest walk the workspace's", async () => {
    await env.DB.prepare(
      `insert into repo_runner_order (workspace_id, repository_id, repository, runner_order, updated_at) values ('w1', 2, 'acme/two', '{"steps":[{"key":"github"}]}', ?1)`,
    )
      .bind(Date.now())
      .run();
    const workspaceOrder = await router.route(groundboxJob);
    expect(workspaceOrder.runner).toBe("groundbox-2vcpu");
    expect(workspaceOrder.ownOrder).toBeUndefined();
    expect(await router.route({ ...groundboxJob, repositoryId: 2 })).toMatchObject({
      runner: "ubuntu-latest",
      skipped: [],
      ownOrder: true,
    });
  });

  test("a miss skips the provider for that repo until a runner picks one of its jobs up", async () => {
    expect((await router.route(groundboxJob)).runner).toBe("groundbox-2vcpu");
    await router.providerMissed("groundbox", 1);
    const skipped = await router.route(groundboxJob);
    expect(skipped).toMatchObject({
      runner: "ubuntu-latest",
      skipped: [{ key: "groundbox", reason: "provider_no_access", access: { cause: "missed" } }],
    });
    // Another repo still goes there.
    expect((await router.route({ ...groundboxJob, repositoryId: 2 })).runner).toBe(
      "groundbox-2vcpu",
    );
    await router.providerPicked("groundbox", 1);
    expect((await router.route(groundboxJob)).runner).toBe("groundbox-2vcpu");
  });

  test("a provider that picked up a job of the repo is seen there until it misses again", async () => {
    expect(await router.providerSeen("groundbox", 1)).toBe(false);
    await router.providerPicked("groundbox", 1);
    expect(await router.providerSeen("groundbox", 1)).toBe(true);
    expect(await router.providerSeen("groundbox", 2)).toBe(false);
    await router.providerMissed("groundbox", 1);
    expect(await router.providerSeen("groundbox", 1)).toBe(false);
  });
});
