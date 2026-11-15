// Keeps the runner up to date while `connect` stays open. `connect` installs the latest
// actions/runner when it starts, and GitHub stops sending jobs to a runner about 30 days after a
// newer release, so a machine left connected for weeks would fall behind.
//
// Every few hours it asks GitHub for the latest release. When there's a newer one, update() gets
// it ready beside the old one and switches over: jobs that start after that run on the new
// runner, and a job already running finishes on the one it started with. It waits for a moment
// when no job is running, so the download and image build don't slow a job down, unless the
// machine stays busy for a day.

import { isNewerVersion } from "@relayrunner/machine-protocol";
import { latestRunnerVersion } from "./install.ts";

const RUNNER_CHECK_MS = 6 * 60 * 60 * 1000;
const BUSY_RETRY_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export interface RunnerUpdaterOptions {
  // The runner version new jobs run on now.
  current: () => string;
  // How many jobs are running now.
  running: () => number;
  // Gets that runner version ready and switches new jobs to it. Throws when it can't.
  update: (version: string) => Promise<void>;
  log: (line: string) => void;
  // The latest actions/runner version. Defaults to asking GitHub.
  latest?: () => Promise<string>;
  checkMs?: number;
  busyRetryMs?: number;
  maxWaitMs?: number;
}

// Starts checking. Call the returned function to stop.
export function keepRunnerUpdated(options: RunnerUpdaterOptions): () => void {
  const checkMs = options.checkMs ?? RUNNER_CHECK_MS;
  const busyRetryMs = options.busyRetryMs ?? BUSY_RETRY_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const latest = options.latest ?? (() => latestRunnerVersion());
  let dueAt = Date.now() + checkMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(check, ms);
    timer.unref();
  };
  const check = async () => {
    if (options.running() > 0 && Date.now() - dueAt < maxWaitMs) return schedule(busyRetryMs);
    try {
      const version = await latest();
      const current = options.current();
      if (!stopped && isNewerVersion(version, current)) {
        options.log(`Updating the runner to actions/runner ${version}…`);
        await options.update(version);
        const running = options.running();
        options.log(
          running > 0
            ? `New jobs run on actions/runner ${version}. Jobs already running finish on ${current}.`
            : `Jobs now run on actions/runner ${version}.`,
        );
      }
    } catch (error) {
      options.log(
        `Couldn't update the runner (${error instanceof Error ? error.message : String(error)}). Trying again later.`,
      );
    }
    dueAt = Date.now() + checkMs;
    schedule(checkMs);
  };

  schedule(checkMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
