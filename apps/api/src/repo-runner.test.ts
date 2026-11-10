import { afterEach, describe, expect, test, vi } from "vitest";
import type { generateJitConfig, RunnerScope } from "./github-app.ts";
import { mintRepoFirst, refusedStatus } from "./repo-runner.ts";

const jit = { runnerId: 9, labels: ["relayrunner"], encodedJitConfig: "e30=" };
const org: RunnerScope = { kind: "org", org: "acme" };
const runner = { name: "relayrunner-pick-1", labels: ["relayrunner"] };
const log = { msg: "pick runner registered on the org", jobId: 1 };
const refused = (status: number) =>
  Object.assign(new Error(`POST failed with ${status}`), { status });

afterEach(() => vi.restoreAllMocks());

test("refusedStatus is the status of a 4xx only", () => {
  expect(refusedStatus(refused(403))).toBe(403);
  expect(refusedStatus(refused(500))).toBeNull();
  expect(refusedStatus(new Error("network"))).toBeNull();
});

describe("mintRepoFirst", () => {
  test("registers on the repo and says so", async () => {
    const mint = vi.fn<typeof generateJitConfig>().mockResolvedValue(jit);
    const fallbackScope = vi.fn(async () => org);
    await expect(
      mintRepoFirst("ghs_x", "acme/app", runner, { fallbackScope, log, mint }),
    ).resolves.toEqual({ jit, scope: { kind: "repo", repo: "acme/app" } });
    expect(fallbackScope).not.toHaveBeenCalled();
  });

  test("falls back to the org on a 4xx, after beforeFallback, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mint = vi
      .fn<typeof generateJitConfig>()
      .mockRejectedValueOnce(refused(403))
      .mockResolvedValueOnce(jit);
    const beforeFallback = vi.fn(async () => {});
    await expect(
      mintRepoFirst("ghs_x", "acme/app", runner, {
        fallbackScope: async () => org,
        beforeFallback,
        log,
        mint,
      }),
    ).resolves.toEqual({ jit, scope: org });
    expect(beforeFallback).toHaveBeenCalledWith(org);
    expect(mint).toHaveBeenLastCalledWith("ghs_x", org, runner);
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
      ...log,
      status: 403,
      repo: "acme/app",
    });
  });

  test("beforeFallback can stop the fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mint = vi.fn<typeof generateJitConfig>().mockRejectedValue(refused(403));
    await expect(
      mintRepoFirst("ghs_x", "acme/app", runner, {
        fallbackScope: async () => org,
        beforeFallback: async () => {
          throw new Error("blocked");
        },
        log,
        mint,
      }),
    ).rejects.toThrow("blocked");
    expect(mint).toHaveBeenCalledOnce();
  });
});
