import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sampleUsage, summarize, treeReading, vmUsage } from "./usage.ts";

const MB = 1024 * 1024;

describe("summarize", () => {
  it("takes the p95 and peak of the readings", () => {
    const readings = Array.from({ length: 20 }, (_, i) => ({
      cpu: (i + 1) / 20,
      memoryBytes: (i + 1) * 100 * MB,
    }));
    expect(summarize(readings, { cpus: 4, memoryMb: 8192 })).toEqual({
      cpuP95: 0.95,
      cpuPeak: 1,
      memoryP95Mb: 1900,
      memoryPeakMb: 2000,
      cpus: 4,
      memoryMb: 8192,
      samples: 20,
    });
  });

  it("keeps CPU between 0 and 1 and has nothing to say without readings", () => {
    const usage = summarize([{ cpu: 1.3, memoryBytes: MB }], { cpus: 2, memoryMb: 1024 });
    expect(usage).toMatchObject({ cpuP95: 1, cpuPeak: 1, samples: 1 });
    expect(summarize([], { cpus: 2, memoryMb: 1024 })).toBeUndefined();
  });
});

describe("treeReading", () => {
  // pid ppid %cpu rss(KB): the runner (10) runs a shell (11) running a compiler (12); 20 is
  // someone else's.
  const ps = `
     1     0   0.0   1000
    10     1  50.0  20000
    11    10   0.0   1000
    12    11 150.0 100000
    20     1  90.0 500000
  `;

  it("sums the runner and everything under it, as a share of the cores", () => {
    expect(treeReading(ps, 10, 4)).toEqual({ cpu: 0.5, memoryBytes: 121_000 * 1024 });
  });

  it("reads nothing once the runner is gone", () => {
    expect(treeReading(ps, 99, 4)).toBeNull();
  });
});

describe("vmUsage", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  // A stand-in for `container stats` with the VM busy on 1.5 cores, as Apple's tool reports it.
  function fakeContainer() {
    dir = mkdtempSync(join(tmpdir(), "rr-usage-"));
    const command = join(dir, "container");
    writeFileSync(
      command,
      `#!/bin/sh
echo '[{"id":"'$5'","cpuUsageUsec":12236987,"cpuUtilization":1.5,"memoryUsageBytes":${512 * MB}}]'
`,
      { mode: 0o755 },
    );
    return command;
  }

  it("reads the VM's busy cores as a share of its cores", async () => {
    const source = vmUsage("relayrunner-7f3k", { cpus: 2, memoryGb: 4 }, fakeContainer());
    expect(source).toMatchObject({ cpus: 2, memoryMb: 4096 });
    expect(await source.read()).toEqual({ cpu: 0.75, memoryBytes: 512 * MB });
  });

  it("reads nothing for a stopped VM", async () => {
    dir = mkdtempSync(join(tmpdir(), "rr-usage-"));
    const command = join(dir, "container");
    writeFileSync(command, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    expect(await vmUsage("gone", { cpus: 2, memoryGb: 4 }, command).read()).toBeNull();
  });
});

describe("sampleUsage", () => {
  it("reads until stopped and summarizes what it read", async () => {
    let calls = 0;
    const sampler = sampleUsage(
      {
        cpus: 2,
        memoryMb: 1024,
        read: async () => (++calls === 1 ? null : { cpu: 0.5, memoryBytes: 256 * MB }),
      },
      5,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    const usage = await sampler.stop();
    expect(usage).toMatchObject({ cpuP95: 0.5, memoryP95Mb: 256, cpus: 2, memoryMb: 1024 });
    expect(usage!.samples).toBe(calls - 1);
  });

  it("skips a reading that fails", async () => {
    const sampler = sampleUsage(
      { cpus: 1, memoryMb: 512, read: () => Promise.reject(new Error("gone")) },
      5,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await sampler.stop()).toBeUndefined();
  });
});
