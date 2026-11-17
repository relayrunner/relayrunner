import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../env.ts";
import { createTestEnv } from "../testing.ts";

// GitHub as the machine's runner sees it: tests set the answers.
const github = vi.hoisted(() => ({
  jobStatus: vi.fn(),
  runnerOnline: vi.fn(),
  deleteRunner: vi.fn(),
}));
vi.mock("../github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
  workflowJobStatus: github.jobStatus,
  runnerOnline: github.runnerOnline,
  deleteRunner: github.deleteRunner,
}));

const { MachineLink } = await import("./machine-link.ts");

function memoryCtx() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") data.set(key, structuredClone(value));
      else for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v));
    },
    delete: async (keys: string | string[]) => {
      for (const key of [keys].flat()) data.delete(key);
    },
    list: async ({ prefix = "" }: { prefix?: string } = {}) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
  };
  return { data, alarm: () => alarm, ctx: { storage, getWebSockets: () => [] } };
}

const runner = {
  machineId: "m1",
  installationId: 7,
  repo: "leonel/cabal",
  id: 99,
  scope: { kind: "repo", repo: "leonel/cabal" },
};
const sent = (rest: object = {}) => ({
  workspaceId: "w1",
  jobId: 42,
  sentAt: Date.now() - 120_000,
  runner,
  checkAt: Date.now() - 1,
  ...rest,
});

describe("MachineLink: jobs that never reach their runner", () => {
  let state: ReturnType<typeof memoryCtx>;
  let link: InstanceType<typeof MachineLink>;
  const requeueSent = vi.fn();

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    github.jobStatus.mockReset().mockResolvedValue("queued");
    github.runnerOnline.mockReset().mockResolvedValue(false);
    github.deleteRunner.mockReset().mockResolvedValue(undefined);
    requeueSent.mockReset();
    const env = {
      ...(await createTestEnv()),
      ROUTER: { getByName: () => ({ requeueSent }) },
    } as unknown as Env;
    state = memoryCtx();
    link = new MachineLink(state.ctx as never, env);
  });

  test("a queued job whose runner isn't connected goes back to the Router", async () => {
    state.data.set("sent:r1", sent());
    state.data.set("hold:r1", { routeId: "r1" });
    await link.alarm();
    expect(github.deleteRunner).toHaveBeenCalledWith("ghs_test", runner.scope, 99);
    expect(requeueSent).toHaveBeenCalledWith("r1", 42, "m1");
    expect([...state.data.keys()]).toEqual([]);
  });

  test("a runner still connected to GitHub keeps the job", async () => {
    github.runnerOnline.mockResolvedValue(true);
    state.data.set("sent:r1", sent());
    await link.alarm();
    expect(requeueSent).not.toHaveBeenCalled();
    expect(state.data.get("sent:r1")).toMatchObject({ jobId: 42, checkAt: undefined });
  });

  test("a runner the machine says is over isn't asked about", async () => {
    state.data.set("sent:r1", sent({ runnerGone: true }));
    await link.alarm();
    expect(github.runnerOnline).not.toHaveBeenCalled();
    expect(requeueSent).toHaveBeenCalledWith("r1", 42, "m1");
  });

  test("a job that started stays where it is", async () => {
    github.jobStatus.mockResolvedValue("in_progress");
    state.data.set("sent:r1", sent({ runnerGone: true }));
    await link.alarm();
    expect(github.deleteRunner).not.toHaveBeenCalled();
    expect(requeueSent).not.toHaveBeenCalled();
    expect(state.data.has("sent:r1")).toBe(false);
  });

  test("a runner GitHub won't remove may have just taken the job: look again later", async () => {
    github.deleteRunner.mockRejectedValue(new Error("DELETE failed with 422"));
    state.data.set("sent:r1", sent());
    await link.alarm();
    expect(requeueSent).not.toHaveBeenCalled();
    const kept = state.data.get("sent:r1") as { checkAt: number };
    expect(kept.checkAt).toBeGreaterThan(Date.now());
    expect(state.alarm()).toBe(kept.checkAt);
  });

  test("a check that isn't due waits for its time", async () => {
    const checkAt = Date.now() + 30_000;
    state.data.set("sent:r1", sent({ checkAt }));
    await link.alarm();
    expect(github.jobStatus).not.toHaveBeenCalled();
    expect(state.alarm()).toBe(checkAt);
  });
});
