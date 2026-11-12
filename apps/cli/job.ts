// Runs the job a `run` message hands the machine: start a slot's copy of actions/runner (slots.ts)
// with the message's JIT config, stream its output, report progress, and clean up after it.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { JobMessage, RunMessage } from "@relayrunner/machine-protocol";
import { checkJitConfig } from "./jit-config.ts";

// A `job` message without its envelope. Whoever sends it on the socket adds `v` and `type`.
export type JobUpdate = Omit<JobMessage, "v" | "type">;

export interface RunJobOptions {
  // The slot's runner directory, holding run.sh. Each slot has its own, so two jobs never share
  // a workspace, credentials or lock.
  dir: string;
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

// What a JIT run leaves in the runner directory: the job's workspace and the runner settings and
// credentials the listener writes out of the JIT config. None of it is good for another job.
const JOB_STATE = ["_work", ".runner", ".credentials", ".credentials_rsaparams"];

// Resolves with the last update it reported ("finished" or "failed"). Never rejects.
export async function runJob(run: RunMessage, options: RunJobOptions): Promise<JobUpdate> {
  const { dir, report } = options;
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

  const lock = join(dir, "job.lock");
  if (!takeLock(lock))
    return finish({
      routeId: run.routeId,
      state: "failed",
      message: `Another job is using the runner in ${dir}.`,
    });

  try {
    clean(dir);
    const child = spawn(join(dir, "run.sh"), ["--jitconfig", run.jitConfig], {
      cwd: dir,
      env: runnerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return finish(await supervise(child, { routeId: run.routeId, name: "run.sh", report, output }));
  } catch (error) {
    return finish({
      routeId: run.routeId,
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clean(dir);
    rmSync(lock, { force: true });
  }
}

// Follows a runner process from spawn to exit: streams its output, reports "started", and
// resolves with the "finished" or "failed" update for the caller to report. Never rejects.
export async function supervise(
  child: ChildProcessByStdio<null, Readable, Readable>,
  options: {
    routeId: string;
    // What the process is called in a failure message, such as "run.sh".
    name: string;
    report: (update: JobUpdate) => void;
    output: (chunk: Buffer, stream: "stdout" | "stderr") => void;
  },
): Promise<JobUpdate> {
  const { routeId, name, report, output } = options;
  child.stdout.on("data", (chunk: Buffer) => output(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => output(chunk, "stderr"));

  const started = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", resolve);
  });
  if (started)
    return { routeId, state: "failed", message: `Could not start the runner: ${started.message}` };
  report({ routeId, state: "started" });

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("close", (code, signal) => resolve([code, signal])),
  );
  if (code === 0) return { routeId, state: "finished" };
  return {
    routeId,
    state: "failed",
    message: signal ? `${name} was stopped by ${signal}` : `${name} exited with ${code}`,
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
