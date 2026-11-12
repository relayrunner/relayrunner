import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerError } from "./install.ts";
import {
  containerName,
  debugLog,
  dockerfile,
  isolatedLauncher,
  isolationAvailable,
  jobImage,
  NO_LOG,
  prepareIsolation,
  runArgs,
  START_SCRIPT,
  unsupportedReason,
  vmSize,
  type Isolation,
} from "./isolated.ts";
import { fakeJitConfig } from "./jit-config.fixture.ts";
import { runJob, type JobUpdate } from "./job.ts";

const jitConfig = fakeJitConfig("7f3k");
const GB = 1024 ** 3;

describe("unsupportedReason", () => {
  it("accepts Apple silicon Macs on macOS 26 or later", () => {
    expect(unsupportedReason("darwin", "arm64", "25.0.0")).toBeNull();
    expect(unsupportedReason("darwin", "arm64", "27.2.0")).toBeNull();
  });

  it("says what's missing everywhere else", () => {
    expect(unsupportedReason("linux", "arm64", "6.8.0")).toContain("Mac with Apple silicon");
    expect(unsupportedReason("darwin", "x64", "25.0.0")).toContain("Intel");
    expect(unsupportedReason("darwin", "arm64", "24.6.0")).toContain("macOS 26");
  });
});

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
    localNetwork: false,
    debug: NO_LOG,
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

  it("starts the start script as root, which sets up the firewall and Docker", () => {
    const args = runArgs("7f3k", isolation);
    expect(args[args.indexOf("--user") + 1]).toBe("0");
    expect(args[args.indexOf("--cap-add") + 1]).toBe("ALL");
    expect(args.join(" ")).not.toContain("RELAYRUNNER_LOCAL_NETWORK");
  });

  it("tells the start script to skip the firewall when the local network is allowed", () => {
    const args = runArgs("7f3k", { ...isolation, localNetwork: true });
    expect(args[args.indexOf("RELAYRUNNER_LOCAL_NETWORK=1") - 1]).toBe("-e");
    expect(args.slice(-2)).toEqual([isolation.image, "/usr/local/bin/relayrunner-start"]);
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

  it("filters what Docker containers send out, and starts Docker before the runner", () => {
    expect(START_SCRIPT).toContain("hook forward");
    expect(START_SCRIPT).toContain('oifname { "lo", "docker0" } accept');
    expect(START_SCRIPT.indexOf("dockerd")).toBeLessThan(START_SCRIPT.indexOf("run.sh"));
    expect(dockerfile("runner:1")).toContain("iptables nftables");
  });

  it("waits for the VM's DNS to answer before the runner starts", () => {
    expect(START_SCRIPT).toContain('RES_OPTIONS="timeout:1 attempts:1" getent hosts');
    expect(START_SCRIPT.indexOf("getent hosts")).toBeLessThan(START_SCRIPT.indexOf("run.sh"));
    expect(START_SCRIPT).not.toContain("resolv.conf <<");
  });

  it("adds the everyday tools to GitHub's runner image, and leaves an image of your own as is", () => {
    expect(dockerfile("runner:1")).toContain("build-essential");
    expect(dockerfile("runner:1")).toContain("cli.github.com/packages");
    expect(dockerfile("runner:1")).toContain("docker-compose-v2");
    expect(dockerfile("runner:1")).toContain("--no-install-recommends");
    expect(dockerfile("runner:1")).toContain("/home/runner/externals/node[0-9]*");
    expect(dockerfile("runner:1")).toContain("prefix=/usr/local");
    expect(dockerfile("runner:1")).toContain("chown runner /usr/local/bin");
    expect(dockerfile("runner:1", false)).not.toContain("build-essential");
    expect(dockerfile("runner:1", false)).toContain("iptables nftables");
    expect(dockerfile("runner:1", false)).toContain("COPY --chmod=755 start.sh");
    expect(jobImage("runner:1", false)).not.toBe(jobImage("runner:1"));
  });

  it("is tagged by its contents, so a new base image builds a new one", () => {
    expect(jobImage("runner:1")).toMatch(/^relayrunner-runner:[a-f\d]{12}$/);
    expect(jobImage("runner:1")).toBe(jobImage("runner:1"));
    expect(jobImage("runner:1")).not.toBe(jobImage("runner:2"));
    expect(dockerfile("runner:1")).toMatch(/^FROM runner:1\n/);
  });
});

describe("isolationAvailable", () => {
  it("is true only on a supported Mac with the container tool installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-available-"));
    try {
      const command = join(dir, "container");
      writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(await isolationAvailable(command, null)).toBe(true);
      expect(await isolationAvailable(command, "needs a Mac")).toBe(false);
      expect(await isolationAvailable(join(dir, "missing"), null)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("debugLog", () => {
  it("is private and leaves the home folder's path out", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-log-"));
    try {
      const debug = debugLog(join(dir, "isolated.log"));
      debug.write(`appRoot ${homedir()}/Library/x`);
      expect(readFileSync(debug.path, "utf8")).toContain("appRoot ~/Library/x");
      expect(statSync(debug.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prepareIsolation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-prepare-"));
    vi.stubGlobal("fetch", async () => Response.json({ tag_name: "v2.338.2", assets: [] }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  // A stand-in for `container` that keeps its images as files in <dir>/images and logs each call.
  function fakeContainer(present: string[]) {
    const images = join(dir, "images");
    const command = join(dir, "container");
    writeFileSync(images, present.map((image) => `${image}\n`).join(""));
    writeFileSync(
      command,
      `#!/bin/sh
echo "$*" >> "${join(dir, "calls")}"
case "$1 $2" in
  "image inspect") grep -qxF "$3" "${images}" ;;
  "image pull") echo "$3" >> "${images}" ;;
  "build --progress") echo "$5" >> "${images}"; echo "built $5" ;;
  "image delete") grep -vxF "$3" "${images}" > "${images}.new"; mv "${images}.new" "${images}" ;;
esac
`,
      { mode: 0o755 },
    );
    return {
      command,
      managed: join(dir, "managed.json"),
      calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n"),
      images: () => readFileSync(images, "utf8").trim().split("\n"),
    };
  }
  const BASE = "ghcr.io/actions/actions-runner:2.338.2";

  it("downloads GitHub's image and builds the job image the first time only", async () => {
    const fake = fakeContainer([]);
    const options = { slots: 1, command: fake.command, managed: fake.managed };
    const isolation = await prepareIsolation(options);
    expect(isolation.image).toBe(jobImage(BASE));
    expect(fake.images()).toEqual([BASE, isolation.image]);
    expect(fake.calls()).toContain("builder delete");

    const before = fake.calls().length;
    await prepareIsolation(options);
    const again = fake.calls().slice(before).join("\n");
    expect(again).not.toContain("pull");
    expect(again).not.toContain("build");
  });

  it("uses the same job image when the local network is allowed", async () => {
    const fake = fakeContainer([]);
    const options = { slots: 1, command: fake.command, managed: fake.managed };
    const { image } = await prepareIsolation(options);
    const isolation = await prepareIsolation({ ...options, localNetwork: true });
    expect(isolation).toMatchObject({ image, localNetwork: true });
    expect(JSON.parse(readFileSync(fake.managed, "utf8"))).toEqual([BASE, image]);
  });

  it("removes images earlier runs left behind, and no others", async () => {
    const old = ["ghcr.io/actions/actions-runner:2.337.0", "relayrunner-runner:000000000000"];
    const fake = fakeContainer([...old, "alpine:latest"]);
    writeFileSync(fake.managed, JSON.stringify(old));
    const removed: string[] = [];
    const isolation = await prepareIsolation({
      slots: 1,
      command: fake.command,
      managed: fake.managed,
      log: (line) => removed.push(line),
    });
    expect(fake.images()).toEqual(["alpine:latest", BASE, isolation.image]);
    expect(removed.filter((line) => line.startsWith("Removed"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(fake.managed, "utf8"))).toEqual([BASE, isolation.image]);
  });

  it("never records an image given with --image, so it's never removed", async () => {
    const fake = fakeContainer([]);
    await prepareIsolation({
      slots: 1,
      command: fake.command,
      managed: fake.managed,
      image: "example.com/my-runner:1",
    });
    expect(JSON.parse(readFileSync(fake.managed, "utf8"))).toEqual([
      jobImage("example.com/my-runner:1", false),
    ]);
  });

  it("records each command and its output in the debug log, and points to it on failure", async () => {
    const fake = fakeContainer([]);
    const debug = debugLog(join(dir, "logs", "isolated.log"));
    await prepareIsolation({ slots: 1, command: fake.command, managed: fake.managed, debug });
    const text = readFileSync(debug.path, "utf8");
    expect(text).toContain("image pull ghcr.io/actions/actions-runner:2.338.2");
    expect(text).toContain(`built ${jobImage(BASE)}`);
    expect(text).toContain("exit 0");

    writeFileSync(fake.command, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const error = await prepareIsolation({ slots: 1, command: fake.command, debug }).catch(
      (caught: unknown) => caught,
    );
    expect((error as RunnerError).message).toContain(debug.path);
  });

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
    return {
      command,
      image: "runner:test",
      localNetwork: false,
      debug: debugLog(join(dir, "isolated.log")),
      runnerVersion: "2.338.2",
      cpus: 2,
      memoryGb: 2,
    };
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

  it("logs the run and its exit without the JIT config", async () => {
    await run(fakeContainer(3));
    const text = readFileSync(join(dir, "isolated.log"), "utf8");
    expect(text).toContain("run --rm --name relayrunner-7f3k");
    expect(text).toContain("relayrunner-7f3k: exit 3");
    expect(text).not.toContain(jitConfig);
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
