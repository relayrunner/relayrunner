// `connect --isolated`: each job runs in its own Linux VM instead of on this machine, using
// Apple's `container` tool (https://github.com/apple/container). The VM starts from GitHub's
// runner image with nothing of the Mac mounted, takes one job and is deleted, so a job can't read
// the user's files, the machine token, or anything an earlier job left behind.

import { spawn } from "node:child_process";
import { arch, availableParallelism, platform, totalmem } from "node:os";
import type { RunMessage } from "@relayrunner/machine-protocol";
import { installedRunners, latestRunnerVersion, RunnerError } from "./install.ts";
import { checkJitConfig } from "./jit-config.ts";
import { runnerEnv, supervise, type JobUpdate, type RunJobOptions } from "./job.ts";

export interface Isolation {
  // The `container` binary. Tests point it at a stand-in.
  command: string;
  // The runner image each job's VM starts from.
  image: string;
  // The actions/runner version in that image, when it's GitHub's own.
  runnerVersion: string;
  // Each VM's share of this machine.
  cpus: number;
  memoryGb: number;
}

// GitHub's runner image, tagged by actions/runner version. It runs as `runner` in /home/runner.
const RUNNER_IMAGE = "ghcr.io/actions/actions-runner";
const RELEASES = "https://github.com/apple/container/releases";

// An even split of the cores between slots, and of half the memory, so the Mac stays usable
// while every slot is busy. At least 2 CPUs and 2 GB each; at most 16 GB.
export function vmSize(slots: number, cores = availableParallelism(), memoryBytes = totalmem()) {
  const gb = memoryBytes / 1024 ** 3;
  return {
    cpus: Math.max(2, Math.floor(cores / slots)),
    memoryGb: Math.min(16, Math.max(2, Math.floor(gb / 2 / slots))),
  };
}

// Checks this machine can run isolated jobs and downloads the runner image, so the first job
// doesn't wait for it. Throws a RunnerError that says what to do otherwise.
export async function prepareIsolation(options: {
  slots: number;
  image?: string;
  command?: string;
  log?: (line: string) => void;
  system?: { platform: string; arch: string };
}): Promise<Isolation> {
  const command = options.command ?? "container";
  const log = options.log ?? (() => {});
  const system = options.system ?? { platform: platform(), arch: arch() };
  if (system.platform !== "darwin" || system.arch !== "arm64")
    throw new RunnerError("ISOLATED_UNSUPPORTED", "--isolated needs a Mac with Apple silicon.");

  const status = await exitCode(command, ["system", "status"]);
  if (status === null)
    throw new RunnerError(
      "ISOLATED_SETUP",
      `--isolated needs Apple's container tool. Install it from ${RELEASES}, then run \`container system start\`.`,
    );
  if (status !== 0)
    throw new RunnerError(
      "ISOLATED_SETUP",
      "Apple's container tool isn't running. Run `container system start`, then try again.",
    );

  const runnerVersion = await runnerImageVersion(log);
  const image = options.image ?? `${RUNNER_IMAGE}:${runnerVersion}`;
  log(`Getting the runner image ${image}…`);
  if ((await exitCode(command, ["image", "pull", image], "inherit")) !== 0)
    throw new RunnerError("ISOLATED_IMAGE", `Could not download the runner image ${image}.`);
  return { command, image, runnerVersion, ...vmSize(options.slots) };
}

// The latest actions/runner version. If GitHub can't be reached, the newest one installed here.
async function runnerImageVersion(log: (line: string) => void) {
  try {
    return await latestRunnerVersion({ os: "linux", arch: "arm64" });
  } catch (error) {
    const [newest] = installedRunners();
    if (!newest) throw error;
    log(
      `Couldn't check for a newer runner (${(error as Error).message}). Using ${newest.version}.`,
    );
    return newest.version;
  }
}

// The VM's name, which is also how a job that's still running is found and deleted.
export function containerName(routeId: string) {
  return `relayrunner-${routeId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

// `container run` arguments for one job. The JIT config travels in the environment (`-e NAME`
// copies it from ours), so it never shows in this machine's process list.
export function runArgs(routeId: string, isolation: Isolation) {
  return [
    "run",
    "--rm",
    "--name",
    containerName(routeId),
    "--cpus",
    String(isolation.cpus),
    "--memory",
    `${isolation.memoryGb}g`,
    "-e",
    "RUNNER_JIT_CONFIG",
    isolation.image,
    "/bin/sh",
    "-c",
    'exec /home/runner/run.sh --jitconfig "$RUNNER_JIT_CONFIG"',
  ];
}

// runJob's isolated twin: same checks and reports, but the runner starts inside a fresh VM.
// Resolves with the last update it reported ("finished" or "failed"). Never rejects.
export async function runIsolatedJob(
  run: RunMessage,
  options: Omit<RunJobOptions, "dir"> & { isolation: Isolation },
): Promise<JobUpdate> {
  const { isolation, report } = options;
  const output =
    options.output ??
    ((chunk, stream) => (stream === "stdout" ? process.stdout : process.stderr).write(chunk));
  const finish = (update: JobUpdate) => {
    report(update);
    return update;
  };

  // Nothing runs on a config that points the runner anywhere but GitHub.
  const checked = checkJitConfig(run.jitConfig, run.routeId);
  if (!checked.ok)
    return finish({
      routeId: run.routeId,
      state: "failed",
      message: `Refused the job's runner config: ${checked.reason}.`,
    });
  options.onChecked?.(checked.target);

  try {
    const child = spawn(isolation.command, runArgs(run.routeId, isolation), {
      env: { ...runnerEnv(), RUNNER_JIT_CONFIG: run.jitConfig },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return finish(
      await supervise(child, { routeId: run.routeId, name: "The runner", report, output }),
    );
  } catch (error) {
    return finish({
      routeId: run.routeId,
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // `--rm` deletes the VM when the runner exits. This covers a `container run` that was stopped
    // before its VM was.
    await exitCode(isolation.command, ["delete", "--force", containerName(run.routeId)]);
  }
}

// The command's exit code, or null when it couldn't start (not installed).
function exitCode(command: string, args: string[], stdio: "ignore" | "inherit" = "ignore") {
  return new Promise<number | null>((resolve) => {
    const child = spawn(command, args, { stdio });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
}
