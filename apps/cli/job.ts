// Runs the job a `run` message hands the machine, and the launcher that runs it on this machine
// in a slot's copy of actions/runner (slots.ts).

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { JobMessage, RunMessage } from "@relayrunner/machine-protocol";
import { checkJitConfig } from "./jit-config.ts";

// A `job` message without its envelope. Whoever sends it on the socket adds `v` and `type`.
export type JobUpdate = Omit<JobMessage, "v" | "type">;

type RunnerProcess = ChildProcessByStdio<null, Readable, Readable>;

// Where a job's runner runs: on this machine (hostLauncher) or in a VM (isolated.ts).
export interface Launcher {
  // Starts the runner with the job's JIT config. Throws when it can't, with the reason.
  start: (run: RunMessage) => RunnerProcess;
  // Runs once the job is over, whether it started or not. `clean` is true when the runner
  // started and exited with 0.
  cleanup: (run: RunMessage, clean: boolean) => void | Promise<void>;
}

export interface RunJobOptions {
  launcher: Launcher;
  report: (update: JobUpdate) => void;
  // The runner's stdout and stderr as they arrive. Defaults to this process's own.
  output?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
  // The repo (or org) the job's runner is registered on, once its config checked out
  // (jit-config.ts). Null when the config doesn't say.
  onChecked?: (target: string | null) => void;
}

// Only what the runner needs from our environment, so the CLI's own secrets (the machine token,
// anything in the user's shell) don't reach workflow steps.
export const runnerEnv = () =>
  Object.fromEntries(
    ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );

// Runs the job a `run` message hands the machine: checks its JIT config, starts the runner,
// streams its output and reports progress. Resolves with the last update it reported ("finished"
// or "failed"). Never rejects.
export async function runJob(run: RunMessage, options: RunJobOptions): Promise<JobUpdate> {
  const { launcher, report } = options;
  const { routeId } = run;
  const output =
    options.output ??
    ((chunk, stream) => (stream === "stdout" ? process.stdout : process.stderr).write(chunk));
  const finish = (update: JobUpdate) => {
    report(update);
    return update;
  };
  const failed = (message: string) => finish({ routeId, state: "failed", message });

  // Nothing runs on a config that points the runner anywhere but GitHub.
  const checked = checkJitConfig(run.jitConfig, routeId);
  if (!checked.ok) return failed(`Refused the job's runner config: ${checked.reason}.`);
  options.onChecked?.(checked.target);

  let clean = false;
  try {
    const child = launcher.start(run);
    child.stdout.on("data", (chunk: Buffer) => output(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => output(chunk, "stderr"));

    const started = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", resolve);
    });
    if (started) return failed(`Could not start the runner: ${started.message}`);
    report({ routeId, state: "started" });

    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("close", (code, signal) => resolve([code, signal])),
    );
    clean = code === 0;
    if (clean) return finish({ routeId, state: "finished" });
    return failed(
      signal ? `The runner was stopped by ${signal}` : `The runner exited with ${code}`,
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    await launcher.cleanup(run, clean);
  }
}

// What a JIT run leaves in the runner directory: the job's workspace and the runner settings and
// credentials the listener writes out of the JIT config. None of it is good for another job.
const JOB_STATE = ["_work", ".runner", ".credentials", ".credentials_rsaparams"];

// Runs jobs on this machine with the copy of actions/runner in `dir`, a slot's runner directory
// holding run.sh. Each slot has its own, so two jobs never share a workspace, credentials or lock.
export function hostLauncher(dir: string): Launcher {
  const lock = join(dir, "job.lock");
  let locked = false;
  return {
    start(run) {
      locked = takeLock(lock);
      if (!locked) throw new Error(`Another job is using the runner in ${dir}.`);
      clean(dir);
      return spawn(join(dir, "run.sh"), ["--jitconfig", run.jitConfig], {
        cwd: dir,
        env: runnerEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    cleanup() {
      // Another job's lock, workspace and credentials are left alone.
      if (!locked) return;
      clean(dir);
      rmSync(lock, { force: true });
      locked = false;
    },
  };
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

// Wraps an output callback so every line starts with `prefix`, such as "[slot 2] ", keeping
// parallel jobs' output apart. A partial line waits for the rest of it; flush() writes what's left.
export function prefixLines(
  prefix: string,
  write: (chunk: Buffer, stream: "stdout" | "stderr") => void,
) {
  const partial = { stdout: "", stderr: "" };
  const output = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = partial[stream] + chunk.toString();
    const end = text.lastIndexOf("\n") + 1;
    partial[stream] = text.slice(end);
    if (end === 0) return;
    const lines = text.slice(0, end).replace(/^(?=.)/gm, prefix);
    write(Buffer.from(lines), stream);
  };
  const flush = () => {
    for (const stream of ["stdout", "stderr"] as const) {
      if (partial[stream]) write(Buffer.from(`${prefix}${partial[stream]}\n`), stream);
      partial[stream] = "";
    }
  };
  return { output, flush };
}
