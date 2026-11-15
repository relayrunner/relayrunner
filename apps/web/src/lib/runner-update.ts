import type { Machine } from "./machines.ts";

/** How close to GitHub's cutoff a runner update turns from a note into a warning. */
const UPDATE_SOON_MS = 7 * 86_400_000;

/**
 * The machine's runner update, or null when its runner is up to date or it doesn't say. `urgent`
 * once GitHub's cutoff is a week away, and `overdue` past it, when GitHub may stop sending it jobs.
 * `relayrunner connect` installs the latest runner when it starts, so a restart updates it.
 */
export function runnerUpdate(machine: Pick<Machine, "runner">, now = Date.now()) {
  const runner = machine.runner;
  if (!runner?.update) return null;
  const updateBy = runner.updateBy ? Date.parse(runner.updateBy) : null;
  return {
    version: runner.version,
    latest: runner.update,
    updateBy,
    urgent: updateBy !== null && now >= updateBy - UPDATE_SOON_MS,
    overdue: updateBy !== null && now >= updateBy,
  };
}
