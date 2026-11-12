import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerError } from "./install.ts";
import {
  containerName,
  dockerfile,
  isolatedLauncher,
  jobImage,
  prepareIsolation,
  runArgs,
  START_SCRIPT,
  vmSize,
  type Isolation,
} from "./isolated.ts";
import { fakeJitConfig } from "./jit-config.fixture.ts";
import { runJob, type JobUpdate } from "./job.ts";

const jitConfig = fakeJitConfig("7f3k");
const GB = 1024 ** 3;

describe("vmSize", () => {
  it("splits the cores and half the memory between slots", () => {
    expect(vmSize(1, 10, 32 * GB)).toEqual({ cpus: 10, memoryGb: 16 });
    expect(vmSize(2, 10, 32 * GB)).toEqual({ cpus: 5, memoryGb: 8 });
  });

  it("never goes below 2 CPUs and 2 GB, or above 16 GB", () => {
    expect(vmSize(4, 4, 8 * GB)).toEqual({ cpus: 2, memoryGb: 2 });
    expect(vmSize(1, 16, 128 * GB)).toEqual({ cpus: 16, memoryGb: 16 });
  });
});

describe("runArgs", () => {
  const isolation: Isolation = {
    command: "container",
    image: "ghcr.io/actions/actions-runner:2.338.2",
    runnerVersion: "2.338.2",
    cpus: 4,
    memoryGb: 8,
  };

  it("starts a throwaway VM with a size cap and nothing mounted", () => {
    const args = runArgs("7f3k", isolation);
    expect(args.slice(0, 8)).toEqual([
      "run",
      "--rm",
      "--name",
      "relayrunner-7f3k",
      "--cpus",
      "4",
      "--memory",
      "8g",
    ]);
    expect(args.slice(-2)).toEqual([isolation.image, "/usr/local/bin/relayrunner-start"]);
    for (const flag of ["-v", "--volume", "--mount", "--ssh", "-p", "--publish"])
      expect(args).not.toContain(flag);
  });

  it("adds only the capability the firewall needs", () => {
    const args = runArgs("7f3k", isolation);
    expect(args.filter((arg) => arg === "--cap-add")).toHaveLength(1);
    expect(args[args.indexOf("--cap-add") + 1]).toBe("NET_ADMIN");
  });

  it("keeps the JIT config out of the arguments", () => {
    expect(runArgs("7f3k", isolation).join(" ")).not.toContain(jitConfig);
  });

  it("makes a safe container name from any route id", () => {
    expect(containerName("Ab_9/x")).toBe("relayrunner-ab-9-x");
  });
});

describe("the job image", () => {
  it("blocks private addresses and drops NET_ADMIN before the runner starts", () => {
    expect(START_SCRIPT).toContain("192.168.0.0/16");
    expect(START_SCRIPT).toContain("meta nfproto ipv6 drop");
    expect(START_SCRIPT.indexOf("nft -f")).toBeLessThan(START_SCRIPT.indexOf("run.sh"));
    expect(START_SCRIPT).toContain("--bounding-set -net_admin,-net_raw");
    expect(START_SCRIPT).toContain("--reuid runner");
  });

  it("is tagged by its contents, so a new base image builds a new one", () => {
    expect(jobImage("runner:1")).toMatch(/^relayrunner-runner:[a-f\d]{12}$/);
    expect(jobImage("runner:1")).toBe(jobImage("runner:1"));
    expect(jobImage("runner:1")).not.toBe(jobImage("runner:2"));
    expect(dockerfile("runner:1")).toMatch(/^FROM runner:1\n/);
  });
});

describe("prepareIsolation", () => {
  it("says how to install the container tool when it's missing", async () => {
    const error = await prepareIsolation({
      slots: 1,
      command: "/nonexistent/container",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).code).toBe("ISOLATED_SETUP");
    expect((error as RunnerError).message).toContain("github.com/apple/container/releases");
  });
});

describe("isolatedLauncher", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-isolated-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A stand-in for `container`: logs each call, and for `run` prints whether the JIT config
  // arrived in the environment and exits with `exit`. Other calls exit with `others`.
  function fakeContainer(exit: number, others = 0): Isolation {
    const command = join(dir, "container");
    writeFileSync(
      command,
      `#!/bin/sh
echo "$*" >> "${join(dir, "calls")}"
[ "$1" = run ] || exit ${others}
[ "$RUNNER_JIT_CONFIG" = "${jitConfig}" ] && echo "config ok"
echo "oops" >&2
exit ${exit}
`,
      { mode: 0o755 },
    );
    return { command, image: "runner:test", runnerVersion: "2.338.2", cpus: 2, memoryGb: 2 };
  }

  async function run(isolation: Isolation, config = jitConfig) {
    const updates: JobUpdate[] = [];
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const result = await runJob(
      { v: 1, type: "run", routeId: "7f3k", jitConfig: config },
      {
        launcher: isolatedLauncher(isolation),
        report: (update) => updates.push(update),
        output: (chunk, stream) => (out[stream] += chunk.toString()),
      },
    );
    return { result, updates, out };
  }

  it("runs the job in a container and reports started then finished", async () => {
    const { result, updates, out } = await run(fakeContainer(0));
    expect(out).toEqual({ stdout: "config ok\n", stderr: "oops\n" });
    expect(updates).toEqual([
      { routeId: "7f3k", state: "started" },
      { routeId: "7f3k", state: "finished" },
    ]);
    expect(result).toEqual(updates[1]);
  });

  it("leaves a finished job's container to --rm", async () => {
    await run(fakeContainer(0));
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
  });

  it("deletes the container when the job fails", async () => {
    const { updates } = await run(fakeContainer(3));
    expect(updates.at(-1)).toEqual({
      routeId: "7f3k",
      state: "failed",
      message: "The runner exited with 3",
    });
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    expect(calls.slice(1)).toEqual(["delete --force relayrunner-7f3k"]);
  });

  it("tries the delete a second time when the first fails", async () => {
    await run(fakeContainer(3, 1));
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    expect(calls.slice(1)).toEqual(Array(2).fill("delete --force relayrunner-7f3k"));
  });

  it("refuses a config that isn't for GitHub without starting a container", async () => {
    const isolation = fakeContainer(0);
    const { updates } = await run(isolation, "not-a-config");
    expect(updates).toHaveLength(1);
    expect(updates[0].state).toBe("failed");
    expect(() => readFileSync(join(dir, "calls"))).toThrow();
  });

  it("reports failed when the container tool can't start", async () => {
    const { updates } = await run({ ...fakeContainer(0), command: join(dir, "missing") });
    expect(updates).toHaveLength(1);
    expect(updates[0].message).toMatch(/^Could not start the runner/);
  });
});
