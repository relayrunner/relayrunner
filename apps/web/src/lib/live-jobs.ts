import { api } from "./api.ts";
import { capacity } from "./capacity.ts";
import type { Environment, TypicalTime } from "./job-times.ts";
import type { Machine, MachineJob } from "./machines.ts";
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

const MIN = 60_000;

/** Example live jobs for `VITE_AUTH_DISABLED=true` dev builds, matching SAMPLE_MACHINES. */
export function sampleLiveJobs(now = Date.now()): LiveJobs {
  const job = (rest: Partial<LiveJob> & Pick<LiveJob, "id" | "name" | "environment">): LiveJob => ({
    repositoryId: 1,
    repository: "acme/app",
    runId: rest.id,
    runAttempt: 1,
    workflow: "CI",
    labels: ["ubuntu-latest"],
    queuedAt: null,
    startedAt: null,
    typical: null,
    ...rest,
  });
  return {
    environments: [
      { key: "github:linux-2-core", label: "ubuntu-latest", detail: "GitHub-hosted" },
      { key: "machine:sample", label: "ada-mbp", detail: "" },
      { key: "machine:sample-mini", label: "studio-mini", detail: "" },
      { key: "self-hosted:default", label: "Self-hosted", detail: "" },
    ],
    running: [
      job({
        id: 101,
        name: "test (macos)",
        environment: "machine:sample",
        labels: ["rr-0123456789ab"],
        startedAt: now - 4 * MIN - 57_000,
        typical: { medianMs: 6 * MIN + 20_000, p90Ms: 7 * MIN + 30_000, samples: 38 },
      }),
      job({
        id: 102,
        name: "lint",
        environment: "github:linux-2-core",
        startedAt: now - 73_000,
        typical: { medianMs: 41_000, p90Ms: 55_000, samples: 50 },
      }),
    ],
    queued: [
      job({
        id: 103,
        name: "build (windows)",
        workflow: "Release",
        environment: "self-hosted:default",
        labels: ["self-hosted", "windows"],
        queuedAt: now - 12 * MIN - 4_000,
      }),
      job({
        id: 104,
        name: "e2e",
        environment: "machine:sample-mini",
        labels: ["rr-89abcdef0123"],
        queuedAt: now - 2 * MIN - 31_000,
      }),
      job({
        id: 105,
        name: "typecheck",
        environment: "github:linux-2-core",
        queuedAt: now - 9_000,
      }),
    ],
  };
}

/** The sample machine's running job, the first of sampleLiveJobs' running jobs. */
export function sampleMachineJob(): MachineJob {
  const job = sampleLiveJobs().running[0]!;
  return {
    repository: job.repository,
    workflow: job.workflow,
    name: job.name,
    url: `https://github.com/${job.repository}/actions/runs/${job.runId}/job/${job.id}`,
    startedAt: new Date(job.startedAt!).toISOString(),
  };
}
