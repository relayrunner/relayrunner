import { afterEach, describe, expect, test, vi } from "vitest";
import type { generateJitConfig, RunnerScope } from "./github-app.ts";
import { mintMachineRunner } from "./machine-runner.ts";

const route = {
  id: "a1b2c3d4e5f6",
  machineId: "m-1",
  machineName: "zach-mbp",
  repo: "acme/app",
  installationId: 42,
};
const jit = { runnerId: 9, labels: ["rr-a1b2c3d4e5f6"], encodedJitConfig: "e30=" };
const org: RunnerScope = { kind: "org", org: "acme" };
const refused = (status: number) =>
  Object.assign(new Error(`POST failed with ${status}`), { status });

afterEach(() => vi.restoreAllMocks());

describe("mintMachineRunner", () => {
  test("registers on the job's repo, with the route label only", async () => {
    const mint = vi.fn<typeof generateJitConfig>().mockResolvedValue(jit);
    const fallback = vi.fn(async () => org);
    await expect(mintMachineRunner("ghs_x", route, fallback, mint)).resolves.toBe(jit);
    expect(mint).toHaveBeenCalledOnce();
    expect(mint).toHaveBeenCalledWith(
      "ghs_x",
      { kind: "repo", repo: "acme/app" },
      { name: expect.stringContaining("zach-mbp"), labels: ["rr-a1b2c3d4e5f6"] },
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  test("falls back to the org, and logs it, when GitHub refuses the repo endpoint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mint = vi
      .fn<typeof generateJitConfig>()
      .mockRejectedValueOnce(refused(403))
      .mockResolvedValueOnce(jit);
    await expect(mintMachineRunner("ghs_x", route, async () => org, mint)).resolves.toBe(jit);
    expect(mint).toHaveBeenLastCalledWith("ghs_x", org, expect.anything());
    expect(warn.mock.calls[0][0]).toContain("machine runner registered on the org");
  });

  test("doesn't fall back for other errors", async () => {
    const mint = vi.fn<typeof generateJitConfig>().mockRejectedValue(refused(500));
    await expect(mintMachineRunner("ghs_x", route, async () => org, mint)).rejects.toThrow("500");
    expect(mint).toHaveBeenCalledOnce();
  });

  test("a personal account's 403 is final: its scope was the repo already", async () => {
    const mint = vi.fn<typeof generateJitConfig>().mockRejectedValue(refused(403));
    const repo: RunnerScope = { kind: "repo", repo: "acme/app" };
    await expect(mintMachineRunner("ghs_x", route, async () => repo, mint)).rejects.toThrow("403");
    expect(mint).toHaveBeenCalledOnce();
  });
});
