import { type LiveJobs, matches, waitReason } from "./live-jobs.ts";
import type { Machine } from "./machines.ts";

/**
 * What fixes an attention item: unpausing the machine, running `relayrunner connect` on it, its
 * runner page on GitHub, adding a runner, or the runner's panel when the signed-in user can't fix
 * it themselves.
 */
export type AttentionFix =
  | { kind: "unpause"; machine: Machine }
  | { kind: "connect" }
  | { kind: "github"; machine: Machine }
  | { kind: "add-runner" }
  | { kind: "runner"; machine: Machine };

/** Something on the Runners page that won't sort itself out, and what fixes it. */
export type AttentionItem = { key: string; text: string; fix: AttentionFix };

const jobs = (count: number) => (count === 1 ? "1 job" : `${count} jobs`);

/**
 * The Runners page's "Needs attention" list, empty when all is well: machines that jobs are stuck
 * waiting on (offline or paused), queued jobs no runner has the labels for, and runners added from
 * GitHub that GitHub no longer has. A machine that's offline with nothing waiting on it isn't
 * listed, since laptops come and go.
 */
export function attentionItems(machines: Machine[], live: LiveJobs): AttentionItem[] {
  const active = machines.filter((machine) => !machine.revokedAt);
  // Queued jobs that won't start on their own, with the machines they're waiting on.
  const stuck = live.queued.filter((job) => waitReason(job, undefined, active).problem);
  const waitingOn = (machine: Machine) =>
    stuck.filter((job) =>
      job.environment.startsWith("machine:")
        ? job.environment === `machine:${machine.id}`
        : matches(job, machine),
    ).length;

  const items: AttentionItem[] = [];
  for (const machine of active) {
    // Gone from GitHub has its own row below; GitHub not answering leaves its status unknown.
    if (machine.github?.missing || machine.github?.unreachable) continue;
    const waiting = waitingOn(machine);
    if (!waiting) continue;
    const github = machine.source === "github";
    if (machine.paused) {
      items.push({
        key: `paused:${machine.id}`,
        text: `${machine.name} is paused with ${jobs(waiting)} waiting`,
        fix: machine.canRevoke ? { kind: "unpause", machine } : { kind: "runner", machine },
      });
    } else if (!machine.status?.online) {
      items.push({
        key: `offline:${machine.id}`,
        text: `${machine.name} is offline with ${jobs(waiting)} waiting`,
        // Only its owner can start its CLI again; a GitHub runner is looked after on GitHub.
        fix: github
          ? { kind: "github", machine }
          : machine.mine
            ? { kind: "connect" }
            : { kind: "runner", machine },
      });
    }
  }

  // Jobs no runner in the workspace could take, one row per set of labels.
  const unmatched = new Map<string, number>();
  for (const job of stuck) {
    if (job.environment.startsWith("machine:")) continue;
    if (active.some((machine) => matches(job, machine))) continue;
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

  for (const machine of active) {
    if (!machine.github?.missing) continue;
    items.push({
      key: `missing:${machine.id}`,
      text: `${machine.name} was removed or re-registered on GitHub`,
      fix: { kind: "add-runner" },
    });
  }
  return items;
}

/**
 * When GitHub was last asked about the workspace's runners added from GitHub: the oldest check,
 * since that's how stale the page could be. Null when there are none, or none answered.
 */
export function githubCheckedAt(machines: Machine[]) {
  const checks = machines.flatMap((machine) =>
    !machine.revokedAt && machine.github?.checkedAt ? [machine.github.checkedAt] : [],
  );
  return checks.length ? Math.min(...checks) : null;
}
