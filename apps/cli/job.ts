// Runs the one job a `run` message hands the machine: start the installed actions/runner with the
// message's JIT config, stream its output, report progress, and clean up after it.

import { spawn } from "node:child_process";
import { readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { JobMessage, RunMessage } from "@relayrunner/machine-protocol";
import type { InstalledRunner } from "./install.ts";
import { checkJitConfig } from "./jit-config.ts";

// A `job` message without its envelope. Whoever sends it on the socket adds `v` and `type`.
export type JobUpdate = Omit<JobMessage, "v" | "type">;

export interface RunJobOptions {
  runner: InstalledRunner;
  report: (update: JobUpdate) => void;
  // The runner's stdout and stderr as they arrive. Defaults to this process's own.
  output?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
  // The repo (or org) the job's runner is registered on, once its config checked out
  // (jit-config.ts). Null when the config doesn't say.
  onChecked?: (target: string | null) => void;
}

// Only what the runner needs from our environment, so the CLI's own secrets (the machine token,
// anything in the user's shell) don't reach workflow steps.
const runnerEnv = () =>
  Object.fromEntries(
    ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );

// What a JIT run leaves in the runner directory: the job's workspace and the runner settings and
// credentials the listener writes out of the JIT config. None of it is good for another job.
const JOB_STATE = ["_work", ".runner", ".credentials", ".credentials_rsaparams"];

// Resolves with the last update it reported ("finished" or "failed"). Never rejects.
export async function runJob(run: RunMessage, options: RunJobOptions): Promise<JobUpdate> {
  const { runner, report } = options;
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

  const lock = join(runner.dir, "job.lock");
  if (!takeLock(lock))
    return finish({
      routeId: run.routeId,
      state: "failed",
      message: `Another job is using the runner in ${runner.dir}.`,
    });

  try {
    clean(runner.dir);
    const child = spawn(join(runner.dir, "run.sh"), ["--jitconfig", run.jitConfig], {
      cwd: runner.dir,
      env: runnerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => output(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => output(chunk, "stderr"));

    const started = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", resolve);
    });
    if (started)
      return finish({
        routeId: run.routeId,
        state: "failed",
        message: `Could not start the runner: ${started.message}`,
      });
    report({ routeId: run.routeId, state: "started" });

    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("close", (code, signal) => resolve([code, signal])),
    );
    if (code === 0) return finish({ routeId: run.routeId, state: "finished" });
    return finish({
      routeId: run.routeId,
      state: "failed",
      message: signal ? `run.sh was stopped by ${signal}` : `run.sh exited with ${code}`,
    });
  } catch (error) {
    return finish({
      routeId: run.routeId,
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clean(runner.dir);
    rmSync(lock, { force: true });
  }
}

function clean(dir: string) {
  for (const name of JOB_STATE) rmSync(join(dir, name), { recursive: true, force: true });
}

// A symlink pointing at our pid: creating one is atomic, and a lock left by a process that has
// since exited is taken over.
function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      symlinkSync(String(process.pid), lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isAlive(Number(readlinkSync(lock)))) return false;
      rmSync(lock, { force: true });
    }
  }
  return false;
}

function isAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
