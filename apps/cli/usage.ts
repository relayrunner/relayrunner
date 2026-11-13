// How much CPU and memory a job uses, sampled while its runner runs and summed up as a JobUsage
// for its `job` message. A job in a VM is read from Apple's container tool; a job on the machine
// itself from its runner's process tree.

import { cpus, totalmem } from "node:os";
import type { JobUsage } from "@relayrunner/machine-protocol";
import { run } from "./device.ts";

// One reading: CPU as a share (0 to 1) of what the job may use, and memory in bytes. Null when
// there's nothing to read yet, such as a VM still booting.
export type Reading = { cpu: number; memoryBytes: number } | null;

// What a job may use and how to read what it uses now.
export interface UsageSource {
  cpus: number;
  memoryMb: number;
  read: () => Promise<Reading>;
}

const SAMPLE_MS = 5_000;
const MB = 1024 * 1024;

/**
 * Reads `source` every few seconds until stop(), which resolves with the job's usage, or
 * undefined when nothing was read (a job too short to sample, or a source that never answered).
 * Calling stop() again resolves with the same answer.
 */
export function sampleUsage(source: UsageSource, intervalMs = SAMPLE_MS) {
  const readings: NonNullable<Reading>[] = [];
  let pending: Promise<void> = Promise.resolve();
  let stopped: Promise<JobUsage | undefined> | undefined;
  const timer = setInterval(() => {
    // Readings never overlap: a slow one delays the next rather than piling up.
    pending = pending.then(() =>
      source.read().then(
        (reading) => void (reading && readings.push(reading)),
        () => undefined, // A failed reading is skipped; the job carries on either way.
      ),
    );
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return (stopped ??= pending.then(() => summarize(readings, source)));
    },
  };
}

export function summarize(
  readings: NonNullable<Reading>[],
  capacity: Pick<UsageSource, "cpus" | "memoryMb">,
): JobUsage | undefined {
  if (readings.length === 0) return undefined;
  const cpu = readings.map((reading) => Math.min(Math.max(reading.cpu, 0), 1));
  const memory = readings.map((reading) => Math.round(reading.memoryBytes / MB));
  return {
    cpuP95: round(p95(cpu)),
    cpuPeak: round(Math.max(...cpu)),
    memoryP95Mb: p95(memory),
    memoryPeakMb: Math.max(...memory),
    cpus: capacity.cpus,
    memoryMb: capacity.memoryMb,
    samples: readings.length,
  };
}

// The nearest-rank 95th percentile.
function p95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

const round = (share: number) => Math.round(share * 1000) / 1000;

/**
 * A job in the VM `name`, read with `container stats`, which reports the cores the VM is busy
 * on right now (it samples for about two seconds per call).
 */
export function vmUsage(
  name: string,
  size: { cpus: number; memoryGb: number },
  command = "container",
): UsageSource {
  return {
    cpus: size.cpus,
    memoryMb: size.memoryGb * 1024,
    async read() {
      const output = await run(command, ["stats", "--format", "json", "--no-stream", name]);
      if (!output) return null;
      const [stats] = JSON.parse(output) as {
        cpuUtilization?: number;
        memoryUsageBytes?: number;
      }[];
      if (typeof stats?.cpuUtilization !== "number" || typeof stats.memoryUsageBytes !== "number")
        return null;
      return { cpu: stats.cpuUtilization / size.cpus, memoryBytes: stats.memoryUsageBytes };
    },
  };
}

/**
 * A job running on this machine, read from `ps` as the runner process `pid` and everything under
 * it. Rougher than a VM's reading: a process the job hands work to outside its tree (Docker
 * Desktop, a simulator) isn't counted, and `ps` reports each process's recent CPU, not exact use.
 */
export function processTreeUsage(pid: number): UsageSource {
  const cores = cpus().length;
  return {
    cpus: cores,
    memoryMb: Math.round(totalmem() / MB),
    async read() {
      const output = await run("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss="]);
      return output ? treeReading(output, pid, cores) : null;
    },
  };
}

/** Sums `ps -o pid=,ppid=,%cpu=,rss=` output over `root` and its descendants. */
export function treeReading(output: string, root: number, cores: number): Reading {
  const children = new Map<number, number[]>();
  const usage = new Map<number, { cpu: number; rssKb: number }>();
  for (const line of output.split("\n")) {
    const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    usage.set(pid!, { cpu: cpu || 0, rssKb: rss || 0 });
    const siblings = children.get(ppid!);
    if (siblings) siblings.push(pid!);
    else children.set(ppid!, [pid!]);
  }
  if (!usage.has(root)) return null;
  let percent = 0;
  let rssKb = 0;
  const stack = [root];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    // Every pid here was read from `ps`: the root was checked above, the rest came with it.
    const own = usage.get(pid)!;
    percent += own.cpu;
    rssKb += own.rssKb;
    stack.push(...(children.get(pid) ?? []));
  }
  return { cpu: percent / 100 / cores, memoryBytes: rssKb * 1024 };
}
