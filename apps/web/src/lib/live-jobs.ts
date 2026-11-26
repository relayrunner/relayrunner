import { api } from "./api.ts";
import { capacity } from "./capacity.ts";
import type { Environment, TypicalTime } from "./job-times.ts";
import type { Machine } from "./machines.ts";
import { runnerUpdate } from "./runner-update.ts";
/** A job still going: running on a runner, or queued and waiting for one (GET /api/runs/live). */
export type LiveJob = {
  id: number;
  repositoryId: number;
  repository: string;
  runId: number;
  runAttempt: number;
  workflow: string | null;
  name: string;
  /** Its runs-on labels. */
  labels: string[];
  /** Environment key: where it runs, or for a queued job the runner it's waiting for. */
  environment: string;
  queuedAt: number | null;
  startedAt: number | null;
  /** How long it usually takes on its runner, when it has 5+ successful runs there. */
  typical: TypicalTime | null;
};

export type LiveJobs = {
  environments: Environment[];
  /** Longest running first. */
  running: LiveJob[];
  /** Longest waiting first. */
  queued: LiveJob[];
};

export const NO_LIVE_JOBS: LiveJobs = { environments: [], running: [], queued: [] };

export function getLiveJobs() {
  return api<LiveJobs>("/runs/live");
}

/** The workspace's self-hosted runners right now, counting each machine's slots as runners. */
export function runnerCounts(machines: Machine[]) {
  let total = 0;
  let running = 0;
  let idle = 0;
  let offline = 0;
  let paused = 0;
  for (const machine of machines) {
    if (machine.revokedAt) continue;
    const slots = capacity(machine.status);
    total += slots.slots;
    running += slots.running;
    // Like its card: a paused machine reads as paused even while it's offline.
    if (machine.paused) paused += slots.slots - slots.running;
    else if (!machine.status?.online) offline += slots.slots;
    else idle += slots.slots - slots.running;
  }
  return { total, running, idle, offline, paused };
}

/** Why a queued job is still waiting. `problem` marks a wait that won't end on its own. */
export type WaitReason = { text: string; problem: boolean };

/** Every one of the job's labels is one of the runner's, as GitHub matches them: ignoring case. */
function hasLabels(job: string[], runner: string[] | undefined) {
  if (!runner?.length) return false;
  const have = new Set(runner.map((label) => label.toLowerCase()));
  return job.every((label) => have.has(label.toLowerCase()));
}

/** The Router's fits (apps/api/src/routing/routing.ts): the machine's own labels, or its VM's. */
export const matches = (job: LiveJob, machine: Machine) =>
  hasLabels(job.labels, machine.labels) || hasLabels(job.labels, machine.isolatedLabels);

/**
 * Why a queued job hasn't started, from the runner it's waiting for: its machine's state, the
 * workspace's runners with its labels, or the cloud service that runs it.
 */
export function waitReason(
  job: LiveJob,
  env: Environment | undefined,
  machines: Machine[],
): WaitReason {
  const provider = job.environment.split(":")[0];
  if (provider === "machine") {
    const machine = machines.find((each) => `machine:${each.id}` === job.environment);
    if (!machine) return { text: "Waiting for its machine", problem: false };
    if (!machine.status?.online) return { text: `${machine.name} is offline`, problem: true };
    if (machine.paused) return { text: `${machine.name} is paused`, problem: true };
    // Past GitHub's cutoff, GitHub may stop sending it jobs at all.
    if (runnerUpdate(machine)?.overdue)
      return { text: `${machine.name} needs a runner update`, problem: true };
    if (!capacity(machine.status).free) return { text: `${machine.name} is busy`, problem: false };
    return { text: `Starting on ${machine.name}`, problem: false };
  }
  if (provider === "self-hosted" || provider === "other") {
    const fits = machines.filter((machine) => !machine.revokedAt && matches(job, machine));
    if (!fits.length) return { text: `No runner with ${job.labels.join(", ")}`, problem: true };
    const online = fits.filter((machine) => machine.status?.online);
    if (!online.length) return { text: "Matching runners are offline", problem: true };
    const open = online.filter((machine) => !machine.paused);
    if (!open.length) return { text: "Matching runners are paused", problem: true };
    if (open.every((machine) => runnerUpdate(machine)?.overdue))
      return { text: "Matching runners need a runner update", problem: true };
    const idle = open.filter((machine) => capacity(machine.status).free).length;
    if (idle)
      return { text: `${idle} idle ${idle === 1 ? "runner" : "runners"} match`, problem: false };
    return { text: `${open.length} matching, all busy`, problem: false };
  }
  if (provider === "github") return { text: "Waiting for GitHub", problem: false };
  if (provider === "container") return { text: "Waiting for a container", problem: false };
  return { text: `Waiting for ${env?.detail || env?.label || "its runner"}`, problem: false };
}
