import { type LiveJob, type LiveJobs, matches, waitReason } from "./live-jobs.ts";
import type { Machine } from "./machines.ts";
import { isPersonal } from "./personal-runner.ts";
import { runnerUpdate } from "./runner-update.ts";

/**
 * What fixes an attention item: unpausing the machine, running `relayrunner connect` on it, its
 * runner page on GitHub, adding a runner, adding back or removing a runner GitHub no longer has,
 * or the runner's panel when the signed-in user can't fix it themselves.
 */
export type AttentionFix =
  | { kind: "unpause"; machine: Machine }
  | { kind: "connect" }
  | { kind: "github"; machine: Machine }
  | { kind: "add-runner" }
  | { kind: "missing"; machine: Machine }
  | { kind: "runner"; machine: Machine };

/** Something on the Runners page that won't sort itself out, and what fixes it. */
export type AttentionItem = { key: string; text: string; fix: AttentionFix };

// lib/job-times.ts has plural(), but importing it pulls in the API client, which this module's
// tests can't load.
const jobs = (count: number) => (count === 1 ? "1 job" : `${count} jobs`);

/**
 * The Runners page's "Needs attention" list, empty when all is well: machines that jobs are stuck
 * waiting on (offline or paused), queued jobs no runner has the labels for, and runners added from
 * GitHub that GitHub no longer has, and machines whose runner GitHub will soon stop sending jobs
 * to. A machine that's offline with nothing waiting on it isn't
 * listed, since laptops come and go, and neither is a teammate's personal runner, which only
 * ever waits on their own jobs.
 */
export function attentionItems(machines: Machine[], live: LiveJobs): AttentionItem[] {
  const active = machines.filter((machine) => !machine.revokedAt);
  // Queued jobs that won't start on their own.
  const stuck = live.queued.filter((job) => waitReason(job, undefined, active).problem);
  const pinned = (job: LiveJob) => job.environment.startsWith("machine:");
  const waitingOn = (machine: Machine) =>
    stuck.filter((job) =>
      pinned(job) ? job.environment === `machine:${machine.id}` : matches(job, machine),
    ).length;

  const items: AttentionItem[] = [];
  const missing: AttentionItem[] = [];
  const updates: AttentionItem[] = [];
  for (const machine of active) {
    if (isPersonal(machine) && machine.mine === false) continue;
    if (machine.github?.missing) {
      missing.push({
        key: `missing:${machine.id}`,
        text: `${machine.name} was removed or re-registered on GitHub`,
        fix: { kind: "missing", machine },
      });
      continue;
    }
    // A week from GitHub's cutoff for a runner update, or past it. Restarting `connect` updates
    // it, so only its owner can.
    const update = runnerUpdate(machine);
    if (update?.urgent)
      updates.push({
        key: `runner-update:${machine.id}`,
        text: update.overdue
          ? `${machine.name} needs a runner update`
          : `${machine.name} needs a runner update soon`,
        fix: machine.mine ? { kind: "connect" } : { kind: "runner", machine },
      });
    // GitHub not answering leaves its status unknown.
    if (machine.github?.unreachable) continue;
    const waiting = waitingOn(machine);
    if (!waiting) continue;
    // In waitReason's order: offline first, then paused.
    if (!machine.status?.online) {
      items.push({
        key: `offline:${machine.id}`,
        text: `${machine.name} is offline with ${jobs(waiting)} waiting`,
        // Only its owner can start its CLI again; a GitHub runner is looked after on GitHub.
        fix:
          machine.source === "github"
            ? { kind: "github", machine }
            : machine.mine
              ? { kind: "connect" }
              : { kind: "runner", machine },
      });
    } else if (machine.paused) {
      items.push({
        key: `paused:${machine.id}`,
        text: `${machine.name} is paused with ${jobs(waiting)} waiting`,
        fix: machine.canRevoke ? { kind: "unpause", machine } : { kind: "runner", machine },
      });
    }
  }

  // Jobs no runner in the workspace could take, one row per set of labels.
  const unmatched = new Map<string, number>();
  for (const job of stuck) {
    if (pinned(job) || active.some((machine) => matches(job, machine))) continue;
    const labels = job.labels.join(", ");
    unmatched.set(labels, (unmatched.get(labels) ?? 0) + 1);
  }
  for (const [labels, count] of unmatched) {
    items.push({
      key: `labels:${labels}`,
      text: `${jobs(count)} waiting for a runner with ${labels}`,
      fix: { kind: "add-runner" },
    });
  }
  return [...items, ...updates, ...missing];
}
