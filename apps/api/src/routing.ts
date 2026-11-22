// Routing a job to a machine, kept free of Durable Object APIs so it can be tested on its own.
//
// 1. A `runs-on: relayrunner` pick job is claimed by a PickRunner, which asks the workspace's
//    Router where the job's run should go. The Router walks the workspace's runner order
//    (decideRoute). A machine step records a route and answers its one-time label
//    `rr-<route id>`; a github or hosted provider step answers the job's own label for it.
//    When nothing fits, the pick fails the relay job with the reason.
// 2. The workflow's next job runs on that label, so GitHub queues it as `runs-on: rr-<route id>`.
// 3. The `queued` webhook for that job claims the route (same repo, same run) and the machine's
//    MachineLink mints an org JIT runner on the label and sends the machine a `run` message.

import {
  type HostedProviderId,
  isProviderLabel,
  SHAPE_ARCHES,
  SHAPE_OSES,
  type ShapeArch,
  type ShapeOs,
  type ShapePlatform,
  SKIPS_PERSONAL_ACCOUNTS,
  SKIPS_PUBLIC_REPOS,
  sellsPlatform,
} from "@relayrunner/providers";
import {
  AUTO,
  byRunnerKey,
  noSizeText,
  notProviderLabelText,
  personalAccountText,
  publicRepoText,
  RUNNER_KEYS,
  RUNNER_LABELS,
  type RelayInputs,
  hasShape,
  type RelayShape,
  type RetryRunner,
  type RunnerKey,
  type RunnerOrder,
  type FreeMinutesProvider,
} from "@relayrunner/runner-order";
import type {
  RouteWalk,
  FullMachine,
  GithubActor,
  MachineSharing,
  NotSharedMachine,
} from "@relayrunner/activity";
import type { AccountUsage } from "./actions-billing.ts";
import { minutesCheck, type MinutesSkip, type MinutesUsage } from "./minutes-rule.ts";
import { context, scalar } from "./pipeline-context.ts";

export const ROUTE_LABEL_PREFIX = "rr-";
// 12 lowercase hex characters.
const ROUTE_LABEL = /^rr-([0-9a-f]{12})$/;

// How long a picked machine is held for its route's job before the hold lapses. The job is
// normally queued seconds after the pick finishes.
export const ROUTE_HOLD_MS = 10 * 60_000;
// How long a route is kept at all, so a redelivered webhook still finds it.
export const ROUTE_TTL_MS = 24 * 60 * 60_000;

export interface Route {
  id: string;
  machineId: string;
  machineName: string;
  installationId: number;
  // owner/name, and GitHub's repository id.
  repo: string;
  repositoryId: number;
  runId: number;
  createdAt: number;
  // reserved: answered by a pick, waiting for its job's `queued` webhook.
  // dispatched: the job was claimed and handed to the machine.
  // done: the machine reported the job started (its own status says busy from then on), or the
  // runner failed.
  state: "reserved" | "dispatched" | "done";
  // The job that claimed the route. Only that job can claim it again (a redelivery).
  jobId?: number;
  // Set when the route chose a runner added from GitHub: the label the pick answered, which the
  // runner carries for good. Unset for connected machines, whose route answers `rr-<route id>`.
  routingLabel?: string;
  // Where on the machine the job was routed: the OS of that place, and whether it is the
  // machine's VM, not the machine itself (runsIsolated). The machine may have reconnected as
  // something else by the time the job is sent, so MachineLink checks both again (placeNow).
  // `os` is unset for a runner added from GitHub and for routes older than it.
  os?: string;
  isolated?: boolean;
  // Set when "Re-run failed jobs" routed the route again (Router.reroute): the attempt it was
  // routed for. Unset means the attempt of the pick that made it.
  runAttempt?: number;
}

export function newRouteId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const routeLabel = (routeId: string) => `${ROUTE_LABEL_PREFIX}${routeId}`;

/** The route id of the first `rr-<route id>` label, or null. GitHub labels ignore case. */
export function routeIdFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    const match = ROUTE_LABEL.exec(label.toLowerCase());
    if (match) return match[1];
  }
  return null;
}

/** Whether a route still keeps its machine from being picked for another job. */
export function holdsMachine(route: Route, now: number) {
  return route.state !== "done" && now - route.createdAt < ROUTE_HOLD_MS;
}

// A connected machine is in every workspace its owner belongs to, and each workspace has its own
// Router, so the routes that hold a machine are also kept on the machine itself (its MachineLink),
// one hold per route. While a route's hold stands, it takes one of the machine's slots; another
// workspace's pick that finds every slot taken tries its next candidate.
export interface MachineHold {
  routeId: string;
  // The workspace whose Router made the route.
  workspaceId: string;
  // When the hold lapses if the machine never reports the job: ROUTE_HOLD_MS after the pick.
  until: number;
}

/**
 * The hold a route takes on a machine, or null when the machine has no free slot: its other
 * unexpired holds plus the jobs it reports running already fill its slots. Taking it again for a
 * route that still holds the machine renews it.
 */
export function takeHold(
  holds: MachineHold[],
  want: { routeId: string; workspaceId: string },
  capacity: { slots: number; running: number },
  now: number,
): MachineHold | null {
  const live = holds.filter((hold) => now < hold.until);
  const renews = live.some((hold) => hold.routeId === want.routeId);
  if (!renews && live.length + capacity.running >= capacity.slots) return null;
  return { ...want, until: now + ROUTE_HOLD_MS };
}

/**
 * Chooses a machine and takes its hold, trying the next choice while another workspace's route
 * holds the one chosen. Null when no candidate is left.
 */
export async function chooseAndHold<M extends { id: string }>(
  choose: (taken: Set<string>) => M | null,
  hold: (machine: M) => Promise<boolean>,
): Promise<M | null> {
  const taken = new Set<string>();
  for (;;) {
    const machine = choose(taken);
    if (!machine) return null;
    if (await hold(machine)) return machine;
    taken.add(machine.id);
  }
}

export interface Candidate {
  id: string;
  name: string;
  online: boolean;
  state: "idle" | "busy" | null;
  // How many jobs it runs at once, and how many it reports running. Left out (a runner added from
  // GitHub) means one slot, in use while busy.
  slots?: number;
  running?: number;
  // The machine's runner labels (machineLabels).
  labels: string[];
  // Its VM's labels, when it also runs jobs in one (isolatedLabels).
  isolatedLabels?: string[];
  // The CPUs a job gets on it and in its VM (machineCpus), null or left out when unknown.
  cpus?: number | null;
  isolatedCpus?: number | null;
  // Paused machines stay connected but never take a new job.
  paused?: boolean;
  // Whose jobs it takes, and its owner's GitHub account id (null when the owner is gone or never
  // signed in with GitHub). Left out means `anyone`, as before sharing existed.
  sharing?: MachineSharing;
  ownerGithubId?: number | null;
}

// Who started a job: the run (`github.actor`) and this attempt (`github.triggering_actor`), and
// which attempt it is (`github.run_attempt`; left out means the run's first).
export interface JobStarters {
  startedBy: GithubActor | null;
  triggeredBy: GithubActor | null;
  runAttempt?: number;
}

/**
 * Whether a machine's sharing lets it take a job. `anyone` takes every job. `only_me` takes a job
 * from a run its owner started, matched by GitHub account id: the first attempt only when its owner
 * started that attempt too, and any re-run of it, whoever re-ran it (a re-run runs the commit and
 * workflow the owner started, so it can't change the code; an automatic retry is one too). A bot,
 * a schedule, a non-member, a run someone else started or a missing id never matches.
 */
export function admits(
  machine: { sharing?: MachineSharing; ownerGithubId?: number | null },
  job: JobStarters,
): boolean {
  if ((machine.sharing ?? "anyone") === "anyone") return true;
  const owner = machine.ownerGithubId;
  if (owner == null || job.startedBy?.id !== owner) return false;
  return (job.runAttempt ?? 1) > 1 || job.triggeredBy?.id === owner;
}

/**
 * Whether a machine admitted to a job must first show that its owner can read the job's repo. A
 * machine shared with `anyone` takes other people's jobs, and being in the workspace doesn't mean
 * its owner may read every repo the workspace's installations see: without this, a member could
 * receive a repo's code and secrets by sharing their machine. A job its owner started (run and
 * attempt) needs no check, and neither does `only_me`, which only takes jobs of runs its owner
 * started.
 */
export function needsOwnerAccess(
  machine: { sharing?: MachineSharing; ownerGithubId?: number | null },
  job: JobStarters,
): boolean {
  if ((machine.sharing ?? "anyone") !== "anyone") return false;
  const owner = machine.ownerGithubId;
  return owner == null || job.startedBy?.id !== owner || job.triggeredBy?.id !== owner;
}

/** The GitHub id of whoever started this attempt, whose own machines a pick tries first. */
export function starterId(job: JobStarters): number | null {
  return job.triggeredBy?.id ?? job.startedBy?.id ?? null;
}

// GitHub's default self-hosted runner labels, so a job's `runs-on` list can be copied into the
// relay's `machine` input as-is.
const OS_LABELS: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };
const ARCH_LABELS: Record<string, string> = { x64: "X64", arm64: "ARM64", arm: "ARM" };

/** A machine's labels from its stored os and arch: `self-hosted`, then OS and arch when known. */
export function machineLabels(machine: { os: string | null; arch: string | null }): string[] {
  const labels = ["self-hosted"];
  const os = machine.os ? OS_LABELS[machine.os] : undefined;
  const arch = machine.arch ? ARCH_LABELS[machine.arch] : undefined;
  if (os) labels.push(os);
  if (arch) labels.push(arch);
  return labels;
}

/** The labels of a machine's VM, its second place for jobs, or undefined when it has none. */
export function isolatedLabels(machine: {
  isolatedOs: string | null;
  isolatedArch: string | null;
}) {
  if (!machine.isolatedOs) return undefined;
  return machineLabels({ os: machine.isolatedOs, arch: machine.isolatedArch });
}

/** A relay input's labels: comma-separated, trimmed, empties dropped. */
export function parseLabels(input: unknown): string[] {
  if (typeof input !== "string") return [];
  return input
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

/** Whether a machine has every wanted label, ignoring case as GitHub does. */
export function hasLabels(machine: string[], wanted: string[]) {
  const have = new Set(machine.map((label) => label.toLowerCase()));
  return wanted.every((label) => have.has(label.toLowerCase()));
}

// A machine's places for jobs, with the CPUs a job gets in each: the machine's cores, or its VM's
// size. Null or left out when unknown (an older CLI, a runner added from GitHub).
type Places = {
  labels: string[];
  isolatedLabels?: string[];
  cpus?: number | null;
  isolatedCpus?: number | null;
};

/** What a job wants of a machine: every label, and at least `cpus` CPUs when its relay says. */
export interface MachineWant {
  labels: string[];
  cpus?: number;
}

/** A job's machine labels, or labels plus CPUs, as a MachineWant. */
export const wantOf = (wanted: string[] | MachineWant): MachineWant =>
  Array.isArray(wanted) ? { labels: wanted } : wanted;

/** What a picked job wants of a machine: its `machine` labels and its relay's `cpus`. */
export const machineWant = (job: { machine: string[]; cpus?: number }): MachineWant => ({
  labels: job.machine,
  ...(job.cpus !== undefined && { cpus: job.cpus }),
});

// Unknown CPUs count as enough: the job may run slower, but it runs.
const enoughCpus = (have: number | null | undefined, cpus: number | undefined) =>
  cpus === undefined || have == null || have >= cpus;

function hostFits(machine: Places, wanted: MachineWant) {
  return hasLabels(machine.labels, wanted.labels) && enoughCpus(machine.cpus, wanted.cpus);
}

function vmFits(machine: Places, wanted: MachineWant) {
  return (
    machine.isolatedLabels !== undefined &&
    hasLabels(machine.isolatedLabels, wanted.labels) &&
    enoughCpus(machine.isolatedCpus, wanted.cpus)
  );
}

/**
 * Whether a job's wanted labels (and CPUs) fit one of a machine's places: the machine itself or
 * its VM.
 */
export function fits(machine: Places, wanted: string[] | MachineWant) {
  const want = wantOf(wanted);
  return hostFits(machine, want) || vmFits(machine, want);
}

/**
 * Whether a job a machine fits runs in its VM. When only one place fits, that one. When both do
 * (the job asked only for `self-hosted` or the arch), the job's GitHub fallback says what it was
 * written for: `ubuntu-*` means Linux, so the VM; anything else, the machine.
 */
export function runsIsolated(machine: Places, wanted: string[] | MachineWant, fallback: string[]) {
  const want = wantOf(wanted);
  if (!vmFits(machine, want)) return false;
  if (!hostFits(machine, want)) return true;
  return fallback.some((label) => /^ubuntu/i.test(label));
}

/**
 * The CPUs a job gets in each of a machine's places, from its stored hello: on the machine itself
 * its cores, unless it runs every job in a VM of its own OS; in its VM, the VM's size.
 */
export function machineCpus(machine: {
  cpuCores: number | null;
  vmCpus: number | null;
  isolatedOs: string | null;
}): { cpus: number | null; isolatedCpus?: number | null } {
  if (machine.isolatedOs) return { cpus: machine.cpuCores, isolatedCpus: machine.vmCpus };
  return { cpus: machine.vmCpus ?? machine.cpuCores };
}

/**
 * Where a machine, as it is connected now, runs a route's job: on itself ("host"), in its VM
 * ("vm"), or nowhere (null) when it no longer has the place the job was routed to. A job routed to
 * a VM never runs on the machine itself. A job routed to the machine itself may run in a VM that
 * now has that OS (a Mac that was all VM and reconnected offering both).
 */
export function placeNow(
  route: Pick<Route, "os" | "isolated">,
  hello: { os: string; isolated?: { os: string } },
): "host" | "vm" | null {
  if (route.isolated) return hello.isolated && hello.isolated.os === route.os ? "vm" : null;
  if (route.os === undefined || route.os === hello.os) return "host";
  return hello.isolated?.os === route.os ? "vm" : null;
}

/** When each machine was last picked: the newest route per machine. */
export function lastPicked(routes: Route[]): Map<string, number> {
  const picked = new Map<string, number>();
  for (const route of routes) {
    const previous = picked.get(route.machineId);
    if (previous === undefined || route.createdAt > previous)
      picked.set(route.machineId, route.createdAt);
  }
  return picked;
}

// How many of a machine's routes a Router holds, by machine id. Routes held for a machine count
// against its slots until the job starts and the machine counts it as running instead.
export type HeldSlots = ReadonlyMap<string, number>;

/** Routes still holding their machine (holdsMachine), counted per machine. */
export function heldSlots(routes: Route[], now: number): Map<string, number> {
  const held = new Map<string, number>();
  for (const route of routes)
    if (holdsMachine(route, now)) held.set(route.machineId, (held.get(route.machineId) ?? 0) + 1);
  return held;
}

/** Slots in use: jobs running plus routes held, out of its slots. Offline counts as none free. */
function slotsInUse(machine: Candidate, held: number) {
  const slots = machine.slots ?? 1;
  const running = machine.running ?? (machine.state === "busy" ? 1 : 0);
  return { slots, used: machine.online ? running + held : slots };
}

/** Whether an online machine has a slot no running job or held route takes. */
export function hasFreeSlot(machine: Candidate, held: HeldSlots) {
  const { slots, used } = slotsInUse(machine, held.get(machine.id) ?? 0);
  return machine.online && used < slots;
}

/**
 * Of the machines with every wanted label whose sharing takes the job, the online, unpaused one
 * with a free slot (hasFreeSlot), or null. The job starter's own machines come first; then the
 * least recently picked (never picked first), ties keeping the candidates' order. No wanted labels
 * means none is required; a job that names no machine labels doesn't get here. No starters means
 * nobody's job: only `anyone` machines take it.
 */
export function chooseMachine(
  candidates: Candidate[],
  held: HeldSlots,
  picked: Map<string, number> = new Map(),
  wanted: string[] | MachineWant = [],
  starters: JobStarters = { startedBy: null, triggeredBy: null },
): Candidate | null {
  const starter = starterId(starters);
  let best: Candidate | null = null;
  let bestOwn = false;
  let bestAt = Infinity;
  for (const machine of candidates) {
    if (machine.paused || !hasFreeSlot(machine, held)) continue;
    if (!fits(machine, wanted) || !admits(machine, starters)) continue;
    const own = starter !== null && machine.ownerGithubId === starter;
    const at = picked.get(machine.id) ?? -Infinity;
    if ((own && !bestOwn) || (own === bestOwn && at < bestAt)) {
      best = machine;
      bestOwn = own;
      bestAt = at;
    }
  }
  return best;
}

/** The online, unpaused machines that fit the job (labels and sharing). */
export function readyMachines<C extends Candidate>(
  candidates: C[],
  wanted: string[] | MachineWant = [],
  starters: JobStarters = { startedBy: null, triggeredBy: null },
): C[] {
  return candidates.filter(
    (machine) =>
      machine.online && !machine.paused && fits(machine, wanted) && admits(machine, starters),
  );
}

/**
 * When chooseMachine found nothing but some online, unpaused machine fits the job (labels and
 * sharing), and every such machine is full: each one's slots in use, counting held routes (at most
 * its slots). Null otherwise, so offline-only or no fitting machine reads as no_machine.
 */
export function fullMachines(
  candidates: Candidate[],
  held: HeldSlots,
  wanted: string[] | MachineWant = [],
  starters: JobStarters = { startedBy: null, triggeredBy: null },
): FullMachine[] | null {
  const fitting = readyMachines(candidates, wanted, starters);
  if (fitting.length === 0 || fitting.some((machine) => hasFreeSlot(machine, held))) return null;
  return fitting.map((machine) => {
    const { slots, used } = slotsInUse(machine, held.get(machine.id) ?? 0);
    return { machine: machine.name, running: Math.min(used, slots), slots };
  });
}

/**
 * When every machine with the wanted labels is paused, their names; otherwise empty. A mix of
 * paused and busy or offline machines isn't "paused": unpausing wouldn't be enough on its own.
 */
export function pausedMatches(
  machines: (Places & { name: string; paused?: boolean })[],
  wanted: string[] | MachineWant = [],
): string[] {
  const matching = machines.filter((machine) => fits(machine, wanted));
  if (matching.length === 0 || !matching.every((machine) => machine.paused)) return [];
  return matching.map((machine) => machine.name);
}

export interface PoolMachine {
  name: string;
  labels: string[];
  isolatedLabels?: string[];
  cpus?: number | null;
  isolatedCpus?: number | null;
  paused?: boolean;
  sharing?: MachineSharing;
  ownerGithubId?: number | null;
  // The owner's display name, for Activity.
  ownerName?: string | null;
}

/**
 * Why no machine took a job that some machine's labels fit, when there's one thing to say: no
 * machine with the labels takes this job's starter (`notShared`), or every one that does is paused
 * (`paused`). Null otherwise: they're busy or offline, or none has the labels.
 */
export function unavailableMachines(
  machines: PoolMachine[],
  wanted: string[] | MachineWant,
  starters: JobStarters,
): { paused: string[] } | { notShared: NotSharedMachine[] } | null {
  const matching = machines.filter((machine) => fits(machine, wanted));
  if (matching.length === 0) return null;
  const admitted = matching.filter((machine) => admits(machine, starters));
  if (admitted.length === 0)
    return {
      notShared: matching.map((machine) => ({
        machine: machine.name,
        owner: machine.ownerName ?? null,
      })),
    };
  const paused = pausedMatches(admitted, wanted);
  return paused.length > 0 ? { paused } : null;
}

export interface QueuedJob {
  jobId: number;
  repositoryId: number;
  runId: number;
}

/** Whether a queued job may take a route: same repo and run, and not claimed by another job. */
export function canClaim(route: Pick<Route, "repositoryId" | "runId" | "jobId">, job: QueuedJob) {
  if (route.repositoryId !== job.repositoryId || route.runId !== job.runId) return false;
  return route.jobId === undefined || route.jobId === job.jobId;
}

// A re-run job routed again on its old route (Router.reroute).
export interface Rerun extends QueuedJob {
  routeId: string;
  // The re-run's attempt, and the earlier attempt whose pick made the route.
  runAttempt: number;
  pickedAttempt: number;
}

/**
 * Whether a re-run may take a route again: one from its own repo and run that no job of this
 * attempt or a later one holds. A route left from the pick itself counts as the pick's attempt.
 */
export function mayReroute(route: Route | undefined, rerun: Rerun) {
  if (!route) return true;
  if (route.repositoryId !== rerun.repositoryId || route.runId !== rerun.runId) return false;
  if (route.routingLabel) return false;
  return (route.runAttempt ?? rerun.pickedAttempt) < rerun.runAttempt;
}

// What the Router needs from a claimed job: its repo and run from the `github` context, and the
// relay's per-provider inputs from `inputs` (RelayInputs: each provider's labels, empty when the
// relay leaves its input out).
export interface JobContext extends RelayInputs {
  repo: string;
  runId: number;
  // 1 for a run's first attempt. A full re-run picks again under a new attempt.
  runAttempt: number;
  // The workflow's name, or null when missing.
  workflow: string | null;
  // The workflow's file in its repo, such as `.github/workflows/ci.yml`, from
  // `github.workflow_ref` (the caller's, in a reusable workflow), or null when missing.
  workflowPath: string | null;
  // Who started the run (`github.actor`, `github.actor_id`), or null when missing.
  startedBy: GithubActor | null;
  // Who started this attempt (`github.triggering_actor`), which differs from `startedBy` on a
  // re-run by someone else. The context has only the login: the id is the actor's when the logins
  // match, else null until the pick looks it up (resolveTriggeredBy).
  triggeredBy: GithubActor | null;
  // The relay's `os`, `arch` and `cpus` inputs (relayShape), left out when it sets none.
  shape?: RelayShape;
}

/**
 * A relay's `os`, `arch` and `cpus` inputs, ignoring case and blanks. A value the relay can't mean
 * (an OS it doesn't know, `cpus: 0`) is dropped, so the job routes as if it were left out.
 */
export function relayShape(inputs: Map<string, unknown> | null | undefined): RelayShape {
  const text = (key: string) => {
    const value = scalar(inputs?.get(key));
    return typeof value === "string" ? value.trim().toLowerCase() : undefined;
  };
  const os = text("os");
  const arch = text("arch");
  const cpus = Number(scalar(inputs?.get("cpus")));
  return {
    ...(SHAPE_OSES.includes(os as ShapeOs) && { os: os as ShapeOs }),
    ...(SHAPE_ARCHES.includes(arch as ShapeArch) && { arch: arch as ShapeArch }),
    ...(Number.isSafeInteger(cpus) && cpus > 0 && cpus <= 1_024 && { cpus }),
  };
}

// Reads the job message's `contextData` (src/pipeline-context.ts). Returns null when
// `github.repository` or `github.run_id` is missing.
// Missing `inputs` (a relay older than per-provider inputs) reads as no labels.
export function jobContext(contextData: unknown): JobContext | null {
  const github = context(contextData, "github");
  if (!github) return null;
  const repo = scalar(github.get("repository"));
  const runId = Number(scalar(github.get("run_id")));
  if (typeof repo !== "string" || !repo.includes("/") || !Number.isSafeInteger(runId) || runId <= 0)
    return null;
  const inputs = context(contextData, "inputs");
  const shape = relayShape(inputs);
  const runAttempt = Number(scalar(github.get("run_attempt")));
  const workflow = scalar(github.get("workflow"));
  const startedBy = actorOf(scalar(github.get("actor")), scalar(github.get("actor_id")));
  const triggeringLogin = scalar(github.get("triggering_actor"));
  const triggeredBy =
    typeof triggeringLogin === "string" && triggeringLogin
      ? {
          login: triggeringLogin,
          id: startedBy && sameLogin(startedBy.login, triggeringLogin) ? startedBy.id : null,
        }
      : startedBy;
  return {
    repo,
    runId,
    runAttempt: Number.isSafeInteger(runAttempt) && runAttempt > 0 ? runAttempt : 1,
    workflow: typeof workflow === "string" && workflow ? workflow : null,
    workflowPath: workflowPathOf(scalar(github.get("workflow_ref")), repo),
    ...byRunnerKey((key) => parseLabels(scalar(inputs?.get(key)))),
    startedBy,
    triggeredBy,
    ...(hasShape(shape) && { shape }),
  };
}

// `acme/app/.github/workflows/ci.yml@refs/heads/main` is `.github/workflows/ci.yml`.
function workflowPathOf(ref: unknown, repo: string): string | null {
  if (typeof ref !== "string") return null;
  const path = ref.split("@")[0];
  const prefix = `${repo}/`;
  return path.toLowerCase().startsWith(prefix.toLowerCase()) && path.length > prefix.length
    ? path.slice(prefix.length)
    : null;
}

function actorOf(login: unknown, id: unknown): GithubActor | null {
  if (typeof login !== "string" || !login) return null;
  const n = Number(id);
  return {
    login,
    id: id !== undefined && id !== "" && Number.isSafeInteger(n) && n > 0 ? n : null,
  };
}

// GitHub logins are case-insensitive.
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Why a step of the order didn't answer: not_configured (the relay left the provider's input
// empty), public_repo (machines never run a public repo's jobs), personal_account (a hosted
// provider that serves only organizations, and a personal account's repo), no_machine (no online, idle
// machine has every wanted label), too_many_labels (`github` or a hosted provider's input names
// more than one label; a runs-on from an output holds one), not_provider_label (a hosted provider's
// input names a label that provider doesn't serve, so the job would sit queued). Shared with the
// Activity page, which explains each.
export type { SkipReason } from "@relayrunner/activity";
import {
  heldText,
  type ProviderHeld,
  spendText,
  startLimitText,
  type SkipReason,
  type SpendUsage,
  type StartLimit,
} from "@relayrunner/activity";

export interface SkippedStep {
  // no_size: the platform a shaped relay asked for (RouteRequest.platform).
  platform?: ShapePlatform;
  key: RunnerKey;
  reason: SkipReason;
  // machine_paused: the paused machines' names.
  paused?: string[];
  // machine_not_shared: the machines that fit but only run their owner's jobs.
  notShared?: NotSharedMachine[];
  // machine_full: the machines that fit, each with its slots in use.
  full?: FullMachine[];
  // minutes_limit and minutes_runway: the job's GitHub account and its usage at the pick, or for
  // Blacksmith the workspace's Blacksmith organization and its free minutes.
  minutes?: Omit<MinutesSkip, "reason">;
  // spend_limit: the job's GitHub account's spend on the provider this month.
  spend?: SpendUsage;
  // start_limit: the provider plan's window with no job starts left.
  starts?: StartLimit;
  // provider_held: why the provider would hold the job.
  held?: ProviderHeld;
  unhealthy?: Unhealthy;
  // no_size: the job's size, in vCPUs.
  vcpus?: number;
}

// What the job's GitHub account has spent on a hosted provider this month (src/provider-spend.ts).
export type SpendCheck = (key: HostedProviderId) => Promise<{ account: string; spentUsd: number }>;

// Whether a hosted provider's plan has job starts left (src/boat-limits.ts): null when it does or
// can't be read, or the window that ran out. Only providers whose plans cap starts ever say no.
export type StartCheck = (key: HostedProviderId) => Promise<StartLimit | null>;

// Whether a hosted provider would hold the job rather than run it (src/groundbox-account.ts): null
// when it would run it or can't be read. Only providers whose connection says so ever say no.
export type HeldCheck = (key: HostedProviderId) => Promise<ProviderHeld | null>;

// A provider's free minutes this month, from the workspace's connection, for its step's limit.
export type FreeMinutesCheck = (key: FreeMinutesProvider) => Promise<MinutesUsage | null>;

// provider_unhealthy: how many jobs in a row weren't picked up, and when the next trial goes.
export type Unhealthy = NonNullable<RouteWalk["skipped"][number]["unhealthy"]>;

// Whether a hosted provider's runner type may take the job (src/provider-health.ts): null, or
// why it's skipped. Asking may let the job through as the runner type's trial.
export type HealthCheck = (key: HostedProviderId, label: string) => Promise<Unhealthy | null>;

// What the machine step's pick found: a route label, every matching machine paused, no matching
// machine taking this job's starter, every online one that fits full, GitHub's API limit keeping
// machines out, or nothing.
export type MachinePick =
  | string
  | { paused: string[] }
  | { notShared: NotSharedMachine[] }
  // `machineIds`: the full machines' ids, for counting the jobs waiting on each (Router.drain).
  | { full: FullMachine[]; machineIds?: string[] }
  | { rateLimited: true }
  // Only for a re-run (Router.reroute): no machine took it, but one that fits it and admits it is
  // offline or paused, so it may yet.
  | { offline: true }
  | null;

// `notInOrder` lists providers the job configured that the order leaves out, either way, so an
// ignored input is never silent.
export type RouteDecision =
  // `step` answered with `runner`, after skipping `skipped` (in order). `waited` when the job
  // queued for a full machine's slot (waitingDecision) rather than getting a runner right away.
  | {
      runner: string;
      step: RunnerKey;
      skipped: SkippedStep[];
      notInOrder: RunnerKey[];
      waited?: true;
    }
  // Nothing fits: fail the relay with `reason`.
  | { runner: null; reason: string; skipped: SkippedStep[]; notInOrder: RunnerKey[] };

export interface RouteRequest extends RelayInputs {
  private: boolean;
  // The repo belongs to a personal account, not an organization. Unset reads as an organization.
  personal?: boolean;
  // An auto relay's size in vCPUs (src/auto-jobs.ts). A provider still set to `auto` has no
  // runner that big.
  size?: number;
  // The platform a relay's `os` and `arch` asked for, when it set a shape. Left out is Linux x64.
  platform?: ShapePlatform;
  // The relay's `cpus` input: a machine needs at least this many (MachineWant).
  cpus?: number;
}

/**
 * Whether a pick that found nowhere to go should wait for a machine instead: some machine that
 * fits was online but full. The job then queues, as it would on GitHub with busy self-hosted
 * runners, rather than failing. A fallback later in the order never gets here: it took the job.
 */
export function waitsForMachine(
  decision: RouteDecision,
): decision is Extract<RouteDecision, { runner: null }> {
  return (
    decision.runner === null && decision.skipped.some((step) => step.reason === "machine_full")
  );
}

/**
 * The decision for a pick that waits for a machine: the machine step answers with the waiting
 * route's label, after the steps skipped before it.
 */
export function waitingDecision(
  decision: Extract<RouteDecision, { runner: null }>,
  label: string,
): RouteDecision {
  const at = decision.skipped.findIndex((step) => step.reason === "machine_full");
  return {
    runner: label,
    step: "machine",
    skipped: decision.skipped.slice(0, at),
    notInOrder: decision.notInOrder,
    waited: true,
  };
}

// A job waiting in the Router's line for a machine slot (Router.wait), under the route id its
// pick answered. Its route is made once a machine takes it (Router.drain).
export interface Waiting {
  id: string;
  queuedAt: number;
  repositoryId: number;
  runId: number;
  // The job queued on the label, once its `queued` webhook arrives (Router.claim).
  jobId?: number;
  // Set for a re-run waiting on its old label (Router.reroute): the attempt it's for.
  runAttempt?: number;
}

/** The waiting jobs in line order: longest waiting first, dropping those past ROUTE_TTL_MS. */
export function waitingLine<W extends Waiting>(waiting: W[], now: number): W[] {
  return waiting
    .filter((entry) => now - entry.queuedAt <= ROUTE_TTL_MS)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * The runner order a retry walks: `same` tries the step the job failed on first, `other` tries it
 * last, and `any` keeps the workspace's order.
 */
export function retryOrder(
  order: RunnerOrder,
  retry: { runner: RetryRunner; failedStep: string | null } | null | undefined,
): RunnerOrder {
  if (!retry?.failedStep || retry.runner === "any") return order;
  const failed = order.steps.filter((step) => step.key === retry.failedStep);
  const rest = order.steps.filter((step) => step.key !== retry.failedStep);
  return { ...order, steps: retry.runner === "same" ? [...failed, ...rest] : [...rest, ...failed] };
}

/**
 * Walks the order top to bottom. A step whose provider the job didn't configure is skipped, and a
 * provider the job configures but the order leaves out is never tried. `pickMachine` is only
 * called when the machine step is reached and may run; it returns the route label, the paused
 * machines when every one that fits is paused, or null. `githubUsage` reads the job's GitHub
 * account's Actions minutes, and is only called when a GitHub step with a minutes limit is reached
 * (once per pick, however many such steps there are). `health` says whether a hosted provider's
 * runner type is skipped for not picking up jobs; when every step that could run the job was
 * skipped that way, the first of them takes it anyway, since a job with nowhere else to go is
 * better off waiting there. `spend` reads the job's account's spend this month on a provider, and
 * is only called when a hosted step with a spend limit is reached. `providerMinutes` reads the
 * workspace's free minutes on Blacksmith or Groundbox, and is only called when that provider's
 * step with a minutes limit is reached. `starts` asks whether a hosted provider's plan has job
 * starts left (Boat's do), and `held` whether it would hold the job (Groundbox's connection says),
 * once its step is about to take the job.
 */
export async function decideRoute(
  order: RunnerOrder,
  job: RouteRequest,
  pickMachine: () => Promise<MachinePick>,
  githubUsage: () => Promise<AccountUsage | null> = async () => null,
  health: HealthCheck = async () => null,
  spend: SpendCheck = async () => ({ account: "", spentUsd: 0 }),
  providerMinutes: FreeMinutesCheck = async () => null,
  starts: StartCheck = async () => null,
  held: HeldCheck = async () => null,
): Promise<RouteDecision> {
  const skipped: SkippedStep[] = [];
  let usage: Promise<AccountUsage | null> | undefined;
  // Read once per provider per pick, however many of its steps have a limit.
  const freeMinutes = new Map<FreeMinutesProvider, Promise<MinutesUsage | null>>();
  const minutesOf = (key: FreeMinutesProvider) => {
    if (!freeMinutes.has(key)) freeMinutes.set(key, providerMinutes(key));
    return freeMinutes.get(key)!;
  };
  const inOrder = new Set(order.steps.map((step) => step.key));
  const notInOrder = RUNNER_KEYS.filter((key) => !inOrder.has(key) && job[key].length > 0);
  for (const step of order.steps) {
    const { key } = step;
    if (key === "machine") {
      if (job.machine.length === 0) skipped.push({ key, reason: "not_configured" });
      else if (!job.private) skipped.push({ key, reason: "public_repo" });
      else {
        const pick = await pickMachine();
        if (typeof pick === "string") return { runner: pick, step: key, skipped, notInOrder };
        if (pick && "notShared" in pick && pick.notShared.length > 0)
          skipped.push({ key, reason: "machine_not_shared", notShared: pick.notShared });
        else if (pick && "paused" in pick && pick.paused.length > 0)
          skipped.push({ key, reason: "machine_paused", paused: pick.paused });
        else if (pick && "full" in pick && pick.full.length > 0)
          skipped.push({ key, reason: "machine_full", full: pick.full });
        else if (pick && "rateLimited" in pick)
          skipped.push({ key, reason: "github_rate_limited" });
        else skipped.push({ key, reason: "no_machine" });
      }
    } else if (key === "github") {
      if (job.github.length === 0) skipped.push({ key, reason: "not_configured" });
      else if (unsized(job.github)) skipped.push(noSize(key, job));
      else if (job.github.length > 1) skipped.push({ key, reason: "too_many_labels" });
      else {
        const over = step.limit
          ? minutesCheck(await (usage ??= githubUsage()), step.limit.percent)
          : null;
        if (over) {
          const { reason, ...minutes } = over;
          skipped.push({ key, reason, minutes });
          continue;
        }
        if (step.spendLimit) {
          // What GitHub billed the job's account for Actions this month, as its billing reports
          // it. An account whose billing we can't read takes the job, as with the minutes limit.
          const account = await (usage ??= githubUsage());
          const limitUsd = step.spendLimit.usd;
          if (account?.readAt && account.netAmount >= limitUsd) {
            const spend = { account: account.accountLogin, spentUsd: account.netAmount, limitUsd };
            skipped.push({ key, reason: "spend_limit", spend });
            continue;
          }
        }
        return { runner: job.github[0], step: key, skipped, notInOrder };
      }
    } else {
      // A hosted provider has no API to ask whether it can take a job, so its step takes any job
      // that names one of its labels; another label would queue forever.
      const labels = job[key];
      if (labels.length === 0) skipped.push({ key, reason: "not_configured" });
      else if (!job.private && SKIPS_PUBLIC_REPOS.includes(key))
        skipped.push({ key, reason: "public_repo" });
      else if (job.personal && SKIPS_PERSONAL_ACCOUNTS.includes(key))
        skipped.push({ key, reason: "personal_account" });
      else if (unsized(labels)) skipped.push(noSize(key, job));
      else if (labels.length > 1) skipped.push({ key, reason: "too_many_labels" });
      else if (!isProviderLabel(key, labels[0]))
        skipped.push({ key, reason: "not_provider_label" });
      else {
        if ("limit" in step && step.limit) {
          const over = minutesCheck(await minutesOf(step.key), step.limit.percent);
          if (over) {
            const { reason, ...minutes } = over;
            skipped.push({ key, reason, minutes });
            continue;
          }
        }
        if (step.spendLimit) {
          const { account, spentUsd } = await spend(key);
          const limitUsd = step.spendLimit.usd;
          if (spentUsd >= limitUsd) {
            skipped.push({ key, reason: "spend_limit", spend: { account, spentUsd, limitUsd } });
            continue;
          }
        }
        // A job Boat can't start sits "Paused by plan limit" until someone re-runs it.
        const ranOut = await starts(key);
        if (ranOut) {
          skipped.push({ key, reason: "start_limit", starts: ranOut });
          continue;
        }
        // A job Groundbox holds waits there until the account can pay for it again.
        const hold = await held(key);
        if (hold) {
          skipped.push({ key, reason: "provider_held", held: hold });
          continue;
        }
        const unhealthy = await health(key, labels[0]);
        if (!unhealthy) return { runner: labels[0], step: key, skipped, notInOrder };
        skipped.push({ key, reason: "provider_unhealthy", unhealthy });
      }
    }
  }
  const fallback = skipped.findIndex((step) => step.reason === "provider_unhealthy");
  if (fallback >= 0) {
    const { key } = skipped[fallback];
    return { runner: job[key][0], step: key, skipped: skipped.slice(0, fallback), notInOrder };
  }
  return { runner: null, reason: noRunnerReason(job, skipped, notInOrder), skipped, notInOrder };
}

// An `auto` input that no label of the job's size replaced (resolveAutoInputs).
const unsized = (labels: string[]) => labels.length === 1 && labels[0] === AUTO;

// The no_size skip of a provider with no label for the job: no runner that big on the platform,
// or none on the platform at all (then no size to name).
function noSize(key: RunnerKey, job: RouteRequest): SkippedStep {
  const { platform } = job;
  if (!platform) return { key, reason: "no_size", vcpus: job.size };
  return {
    key,
    reason: "no_size",
    platform,
    ...(sellsPlatform(key, platform) && { vcpus: job.size }),
  };
}

/** The message a relay fails with when nothing fits, naming why each provider couldn't take it. */
export function noRunnerReason(
  job: RouteRequest,
  skipped: SkippedStep[],
  notInOrder: RunnerKey[],
): string {
  if (RUNNER_KEYS.every((key) => job[key].length === 0))
    return `${NO_RUNNER}: the relay sets no provider, such as \`machine\` or \`github\`.`;
  const parts = skipped.map(
    ({
      key,
      reason,
      paused = [],
      notShared = [],
      full = [],
      minutes,
      spend,
      starts,
      held,
      vcpus,
      platform,
    }) => {
      switch (reason) {
        case "not_configured":
          return `\`${key}\` isn't set on this relay`;
        case "public_repo":
          return publicRepoText(key);
        case "personal_account":
          return personalAccountText(key);
        case "no_machine": {
          const labels = job.machine.filter((label) => label.toLowerCase() !== "self-hosted");
          const wants = [...labels, ...(job.cpus ? [`${job.cpus}+ CPUs`] : [])];
          return wants.length === 0
            ? "no self-hosted machine is online and idle"
            : `no self-hosted machine with ${wants.join(", ")} is online and idle`;
        }
        case "machine_paused":
          return paused.length === 1
            ? `the only machine that fits, ${paused[0]}, is paused`
            : `every machine that fits is paused (${paused.join(", ")})`;
        case "machine_not_shared":
          return notSharedText(notShared);
        case "machine_full":
          return fullText(full);
        case "github_rate_limited":
          return "GitHub's API limit for this org was reached, so no machine could be checked";
        case "too_many_labels":
          return `\`${key}\` takes one label, not ${job[key].join(", ")}`;
        case "not_provider_label":
          return `\`${key}\` ${notProviderLabelText(key, job[key])}`;
        case "minutes_limit":
        case "minutes_runway":
          return minutesText(reason, minutes, key);
        case "spend_limit":
          return spendText(RUNNER_LABELS[key], spend);
        case "start_limit":
          return startLimitText(RUNNER_LABELS[key], starts);
        case "provider_held":
          return heldText(RUNNER_LABELS[key], held);
        // Never the reason nothing fit: an unhealthy step takes the job when no other can.
        case "provider_unhealthy":
          return `${RUNNER_LABELS[key]} isn't picking up jobs`;
        case "no_size":
          return noSizeText(key, vcpus, platform);
      }
    },
  );
  for (const key of notInOrder) parts.push(`${RUNNER_LABELS[key]} isn't in your runner order`);
  return `${NO_RUNNER}: ${parts.join("; ")}.`;
}

export const NO_RUNNER = "No runner available";

/** "atticus-mbp only runs Atticus's jobs", or for several, "a and b only run their owners' jobs". */
export function notSharedText(machines: NotSharedMachine[]): string {
  if (machines.length === 1) {
    const [{ machine, owner }] = machines;
    return `${machine} only runs ${owner ? `${owner}'s` : "its owner's"} jobs`;
  }
  const names = machines.map((m) => m.machine);
  const list =
    names.length === 2
      ? names.join(" and ")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} only run their owners' jobs`;
}

/** "atticus-mbp is full (2 of 2 running)", or for several, "every machine that fits is full (…)". */
export function fullText(machines: FullMachine[]): string {
  if (machines.length === 1) {
    const [{ machine, running, slots }] = machines;
    return `${machine} is full (${running} of ${slots} running)`;
  }
  const each = machines.map((m) => `${m.machine} ${m.running} of ${m.slots}`).join(", ");
  return `every machine that fits is full (${each} running)`;
}

const count = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * "relayrunner has used 1,640 of its 2,000 included minutes (82%), past the 80% limit", or for
 * Blacksmith "relayrunner has used 2,450 of its 3,000 free Blacksmith minutes (82%), …".
 */
export function minutesText(
  reason: "minutes_limit" | "minutes_runway",
  minutes: SkippedStep["minutes"],
  key: RunnerKey = "github",
): string {
  if (!minutes) return `${RUNNER_LABELS[key]} is past its minutes limit`;
  const { account, usedMinutes, quotaMinutes, percent, burnRatePerHour } = minutes;
  const free = key !== "github";
  const kind = free ? `free ${RUNNER_LABELS[key]} minutes` : "included minutes";
  const used = `${account || "This workspace"} has used ${count(usedMinutes)} of its ${count(quotaMinutes)} ${kind} (${Math.floor((usedMinutes / quotaMinutes) * 100)}%)`;
  return reason === "minutes_limit"
    ? `${used}, past the ${percent}% limit`
    : `${used}, and at ${count(burnRatePerHour ?? 0)} minutes an hour it could run out before ${free ? `${RUNNER_LABELS[key]}'s usage` : "GitHub's billing"} catches up`;
}
