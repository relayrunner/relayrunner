import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeJitConfig } from "./jit-config.fixture.ts";
import { hostLauncher, runJob, type JobUpdate } from "./job.ts";
import { defaultConcurrency, ensureSlots, parseConcurrency, slotDir } from "./slots.ts";

describe("concurrency", () => {
  it("defaults to 2 slots with 8 or more cores, otherwise 1", () => {
    expect(defaultConcurrency(4)).toBe(1);
    expect(defaultConcurrency(7)).toBe(1);
    expect(defaultConcurrency(8)).toBe(2);
    expect(defaultConcurrency(16)).toBe(2);
    expect(parseConcurrency(undefined, 12)).toBe(2);
    expect(parseConcurrency(undefined, 2)).toBe(1);
  });

  it("takes --concurrency over the default", () => {
    expect(parseConcurrency("1", 16)).toBe(1);
    expect(parseConcurrency("4", 2)).toBe(4);
  });

  it.each(["0", "-1", "1.5", "two", "1e3", "1001"])("refuses --concurrency %s", (value) => {
    expect(() => parseConcurrency(value)).toThrow(/whole number from 1 to 1000/);
  });
});

describe("ensureSlots", () => {
  let root: string;
  const install = (version: string) => {
    const dir = join(root, version);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "run.sh"), `#!/bin/sh\necho ${version} "$PWD"\n`, { mode: 0o755 });
    writeFileSync(join(dir, "bin", "Runner.Listener"), version);
    symlinkSync("bin/Runner.Listener", join(dir, "listener"));
    return { version, dir };
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rr-slots-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies the runner into one directory per slot", () => {
    const runner = install("2.329.0");
    const lines: string[] = [];
    const dirs = ensureSlots(runner, 2, (line) => lines.push(line));

    expect(dirs).toEqual([join(runner.dir, "slot-1"), join(runner.dir, "slot-2")]);
    for (const dir of dirs) {
      expect(readFileSync(join(dir, "bin", "Runner.Listener"), "utf8")).toBe("2.329.0");
      expect(existsSync(join(dir, "run.sh"))).toBe(true);
    }
    // Slot 2 isn't copied into itself or into slot 1, and no temporary copy is left.
    expect(existsSync(join(dirs[1], "slot-1"))).toBe(false);
    expect(readdirSync(runner.dir).sort()).toEqual(
      ["bin", "listener", "run.sh", "slot-1", "slot-2"].sort(),
    );
    expect(lines).toEqual(["Setting up 2 runner slots…"]);
  });

  it("reuses slots that are there and copies only what's missing", () => {
    const runner = install("2.329.0");
    ensureSlots(runner, 1);
    writeFileSync(join(slotDir(runner, 1), "marker"), "kept");
    // A half-made slot with no run.sh is made again.
    mkdirSync(slotDir(runner, 2));
    writeFileSync(join(slotDir(runner, 2), "junk"), "");

    const lines: string[] = [];
    ensureSlots(runner, 2, (line) => lines.push(line));
    expect(readFileSync(join(slotDir(runner, 1), "marker"), "utf8")).toBe("kept");
    expect(existsSync(join(slotDir(runner, 2), "run.sh"))).toBe(true);
    expect(existsSync(join(slotDir(runner, 2), "junk"))).toBe(false);
    expect(lines).toEqual(["Setting up runner slot 2…"]);
  });

  it("makes fresh slots from a new runner version", () => {
    ensureSlots(install("2.329.0"), 1);
    const next = install("2.330.0");
    const [dir] = ensureSlots(next, 1);
    expect(dir).toBe(join(root, "2.330.0", "slot-1"));
    expect(readFileSync(join(dir, "bin", "Runner.Listener"), "utf8")).toBe("2.330.0");
  });

  it("doesn't copy job state left in the installed runner", () => {
    const runner = install("2.329.0");
    mkdirSync(join(runner.dir, "_work"));
    writeFileSync(join(runner.dir, ".credentials"), "secret");
    symlinkSync("1", join(runner.dir, "job.lock"));
    const [dir] = ensureSlots(runner, 1);
    for (const name of ["_work", ".credentials", "job.lock"])
      expect(existsSync(join(dir, name))).toBe(false);
  });

  it("keeps each slot's lock and job state to itself", async () => {
    const runner = install("2.329.0");
    const [one, two] = ensureSlots(runner, 2);
    // A job holds slot 1 (a live process's lock); slot 2 still runs one.
    symlinkSync(String(process.ppid), join(one, "job.lock"));
    const run = async (dir: string) => {
      const updates: JobUpdate[] = [];
      let out = "";
      await runJob(
        { v: 1, type: "run", routeId: "7f3k", jitConfig: fakeJitConfig("7f3k") },
        {
          launcher: hostLauncher(dir),
          report: (u) => updates.push(u),
          output: (chunk) => (out += chunk.toString()),
        },
      );
      return { updates, out };
    };

    expect((await run(one)).updates).toMatchObject([{ state: "failed", message: /Another job/ }]);
    const { updates, out } = await run(two);
    expect(updates.at(-1)).toEqual({ routeId: "7f3k", state: "finished" });
    expect(out.trim()).toBe(`2.329.0 ${two}`);
    expect(readlinkSync(join(one, "job.lock"))).toBe(String(process.ppid));
  });
});
