import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prefixLines, runJob, type JobUpdate } from "./job.ts";
import { fakeJitConfig } from "./jit-config.fixture.ts";

const jitConfig = fakeJitConfig("7f3k");

// A stand-in for actions/runner's run.sh: echoes its arguments, leaves job state behind like a
// real JIT run, and exits with $EXIT.
const fakeRunSh = (exit: number) => `#!/bin/sh
echo "args: $*"
echo "oops" >&2
mkdir -p _work/repo && touch .runner .credentials
exit ${exit}
`;

describe("runJob", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-job-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function run(exit: number) {
    writeFileSync(join(dir, "run.sh"), fakeRunSh(exit), { mode: 0o755 });
    const updates: JobUpdate[] = [];
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const result = await runJob(
      { v: 1, type: "run", routeId: "7f3k", jitConfig },
      {
        dir,
        report: (update) => updates.push(update),
        output: (chunk, stream) => (out[stream] += chunk.toString()),
      },
    );
    return { result, updates, out };
  }

  it("runs run.sh with the JIT config and reports started then finished", async () => {
    const { result, updates, out } = await run(0);
    expect(out).toEqual({ stdout: `args: --jitconfig ${jitConfig}\n`, stderr: "oops\n" });
    expect(updates).toEqual([
      { routeId: "7f3k", state: "started" },
      { routeId: "7f3k", state: "finished" },
    ]);
    expect(result).toEqual(updates[1]);
  });

  it("reports failed with the exit code", async () => {
    const { updates } = await run(3);
    expect(updates.at(-1)).toEqual({
      routeId: "7f3k",
      state: "failed",
      message: "run.sh exited with 3",
    });
  });

  it("deletes the work directory and JIT credentials afterwards", async () => {
    mkdirSync(join(dir, "_diag"));
    await run(0);
    for (const name of ["_work", ".runner", ".credentials", "job.lock"])
      expect(existsSync(join(dir, name))).toBe(false);
    expect(existsSync(join(dir, "_diag"))).toBe(true);
  });

  it("reports failed when run.sh is missing", async () => {
    const updates: JobUpdate[] = [];
    await runJob(
      { v: 1, type: "run", routeId: "7f3k", jitConfig },
      { dir, report: (u) => updates.push(u), output: () => {} },
    );
    expect(updates).toMatchObject([{ state: "failed", message: /Could not start the runner/ }]);
  });

  it("refuses a runner config that doesn't point at GitHub, without starting run.sh", async () => {
    writeFileSync(join(dir, "run.sh"), fakeRunSh(0), { mode: 0o755 });
    const updates: JobUpdate[] = [];
    const output: string[] = [];
    await runJob(
      {
        v: 1,
        type: "run",
        routeId: "7f3k",
        jitConfig: fakeJitConfig("7f3k", { runner: { ServerUrlV2: "https://evil.example/" } }),
      },
      {
        dir,
        report: (u) => updates.push(u),
        output: (chunk) => output.push(chunk.toString()),
      },
    );
    expect(updates).toEqual([
      {
        routeId: "7f3k",
        state: "failed",
        message:
          "Refused the job's runner config: it points the runner at https://evil.example, not GitHub.",
      },
    ]);
    expect(output).toEqual([]);
  });

  it("refuses to run while another live process holds the runner", async () => {
    symlinkSync(String(process.ppid), join(dir, "job.lock"));
    const { updates } = await run(0);
    expect(updates).toMatchObject([{ state: "failed", message: /Another job/ }]);
  });

  it("takes over a lock left by a process that exited", async () => {
    symlinkSync("999999999", join(dir, "job.lock"));
    const { updates } = await run(0);
    expect(updates.at(-1)).toEqual({ routeId: "7f3k", state: "finished" });
  });
});

describe("prefixLines", () => {
  it("starts every line with the prefix, holding a partial line until it ends", () => {
    const written: string[] = [];
    const { output, flush } = prefixLines("[slot 2] ", (chunk, stream) =>
      written.push(`${stream}:${chunk.toString()}`),
    );
    output(Buffer.from("one\ntw"), "stdout");
    output(Buffer.from("o\n\nthree"), "stdout");
    output(Buffer.from("err\n"), "stderr");
    flush();
    expect(written).toEqual([
      "stdout:[slot 2] one\n",
      "stdout:[slot 2] two\n\n",
      "stderr:[slot 2] err\n",
      "stdout:[slot 2] three\n",
    ]);
  });
});
