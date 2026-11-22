import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../env.ts";
import { createTestEnv } from "../testing.ts";

const github = vi.hoisted(() => ({
  workflowJobRunner: vi.fn(),
  runAttemptStatus: vi.fn(),
  rerunJob: vi.fn(),
  deleteRunner: vi.fn(),
}));
vi.mock("../github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
  runAttemptTriggeringActor: async () => ({ id: 1, login: "atticoos" }),
  ...github,
}));
const runner = vi.hoisted(() => ({ request: {} as unknown, complete: vi.fn() }));
vi.mock("../repo-runner.ts", () => ({
  mintRepoFirst: vi.fn(async () => ({
    jit: { encodedJitConfig: "jit", runnerId: 5 },
    scope: { kind: "repo", repo: "acme/app" },
  })),
}));
vi.mock("../runner-protocol.ts", () => ({
  decodeJitConfig: () => ({}),
  latestRunnerVersion: async () => "2.338.2",
  waitForJob: async () => runner.request,
  RunnerClient: class {
    openSession = async () => {};
    closeSession = async () => {};
    claim = async () => ({ message: {} });
    complete = runner.complete;
  },
}));

const { ProviderTakeover } = await import("./provider-takeover.ts");

function memoryState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") data.set(key, value);
      else for (const [k, v] of Object.entries(key)) data.set(k, v);
    },
    setAlarm: async (at: number) => {
      alarm = at;
    },
  };
  return { data, alarm: () => alarm, ctx: { storage } };
}

const work = {
  jobId: 42,
  jobName: "test",
  workflow: "CI",
  installationId: 7,
  workspaceId: "w1",
  repo: "acme/app",
  repositoryId: 1,
  runId: 9,
  runAttempt: 1,
  key: "groundbox" as const,
  label: "groundbox-2vcpu",
  queuedAt: Date.now(),
};

describe("ProviderTakeover", () => {
  let env: Env;
  let state: ReturnType<typeof memoryState>;
  let takeover: InstanceType<typeof ProviderTakeover>;
  const providerMissed = vi.fn();
  const providerPicked = vi.fn();

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const fn of [...Object.values(github), runner.complete, providerMissed, providerPicked])
      fn.mockReset();
    runner.request = {};
    const testEnv = await createTestEnv();
    const now = Date.now();
    for (const sql of [
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (7, 10, 'acme', 'Organization', ?1, ?1)",
      "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 7, 'W', 'w', ?1)",
      // The run's relay, and where it sent the job.
      "insert into workflow_job (id, installation_id, repository_id, repository_full_name, run_id, run_attempt, name, kind, status, labels, head_sha, github_created_at, created_at, updated_at) values (41, 7, 1, 'acme/app', 9, 1, 'relay', 'pick', 'completed', '[\"relayrunner\"]', 'abc', ?1, ?1, ?1)",
      "insert into route_decision (workspace_id, repository_id, run_id, run_attempt, pick_job_id, step, runner, skipped, not_in_order, machine, github, hosted, created_at) values ('w1', 1, 9, 1, 'relay-a', 'groundbox', 'groundbox-2vcpu', '[]', '[]', '[]', '[]', '{}', ?1)",
    ])
      await testEnv.DB.prepare(sql).bind(now).run();
    env = {
      ...testEnv,
      ROUTER: { getByName: () => ({ providerMissed, providerPicked }) },
    } as unknown as Env;
    state = memoryState();
    takeover = new ProviderTakeover(state.ctx as never, env);
  });

  test("waits a minute after the job queued, and only once per job", async () => {
    expect(await takeover.start(work)).toBe(true);
    expect(state.alarm()).toBe(work.queuedAt + 60_000);
    expect(await takeover.start(work)).toBe(false);
  });

  test("a job a provider runner picked up clears the provider for the repo", async () => {
    await takeover.start(work);
    github.workflowJobRunner.mockResolvedValue({ status: "in_progress", runnerName: "gbx-1" });
    await takeover.alarm();
    expect(providerPicked).toHaveBeenCalledWith("groundbox", 1);
    expect(runner.complete).not.toHaveBeenCalled();
  });

  test("a job still queued is ended, the provider skipped for the repo, and the relay re-run", async () => {
    await takeover.start(work);
    github.workflowJobRunner.mockResolvedValue({ status: "queued", runnerName: null });
    await takeover.alarm();
    expect(runner.complete).toHaveBeenCalledWith(expect.anything(), "failed", {
      error: expect.stringContaining("Groundbox didn't pick up this job within a minute"),
    });
    expect(providerMissed).toHaveBeenCalledWith("groundbox", 1);
    expect(state.data.get("phase")).toBe("rerun");

    // GitHub refuses a re-run while the run is still going.
    github.runAttemptStatus.mockResolvedValue("in_progress");
    await takeover.alarm();
    expect(github.rerunJob).not.toHaveBeenCalled();

    github.runAttemptStatus.mockResolvedValue("completed");
    github.rerunJob.mockResolvedValue(null);
    await takeover.alarm();
    expect(github.rerunJob).toHaveBeenCalledWith("ghs_test", "acme/app", 41);
    const retry = await env.DB.prepare("select kind, runner, status from job_retry").first();
    expect(retry).toEqual({ kind: "provider_missed", runner: "other", status: "requested" });
  });

  test("a later attempt that misses again is ended without another re-run", async () => {
    await takeover.start({ ...work, runAttempt: 3 });
    github.workflowJobRunner.mockResolvedValue({ status: "queued", runnerName: null });
    await takeover.alarm();
    expect(runner.complete).toHaveBeenCalledOnce();
    expect(state.data.get("phase")).toBe("takeover");
  });
});
