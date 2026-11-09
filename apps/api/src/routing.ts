// Routing a job to a machine, kept free of Durable Object APIs so it can be tested on its own.
//
// 1. A `runs-on: relayrunner` pick job is claimed by a PickRunner, which asks the workspace's
//    Router where the job's run should go. The Router walks the workspace's runner order
//    (decideRoute). A machine step records a route and answers its one-time label
//    `rr-<route id>`; a github or blacksmith step answers the job's own label for that provider.
//    When nothing fits, the pick fails the relay job with the reason.
// 2. The workflow's next job runs on that label, so GitHub queues it as `runs-on: rr-<route id>`.
// 3. The `queued` webhook for that job claims the route (same repo, same run) and the machine's
//    MachineLink mints an org JIT runner on the label and sends the machine a `run` message.

import {
  RUNNER_KEYS,
  RUNNER_LABELS,
  type RunnerKey,
  type RunnerOrder,
} from "@relayrunner/runner-order";
import type { AccountUsage } from "./actions-billing.ts";
import { minutesCheck, type MinutesSkip } from "./minutes-rule.ts";
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

export interface Candidate {
  id: string;
  name: string;
  online: boolean;
  state: "idle" | "busy" | null;
  // The machine's runner labels (machineLabels).
  labels: string[];
  // Paused machines stay connected but never take a new job.
  paused?: boolean;
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

/**
 * Of the machines with every wanted label, the online, idle, unpaused one no route holds that was
 * least recently picked, or null. Machines never picked come first; ties keep the candidates' order.
 * No wanted labels means none is required; a job that names no machine labels doesn't get here.
 */
export function chooseMachine(
  candidates: Candidate[],
  held: Set<string>,
  picked: Map<string, number> = new Map(),
  wanted: string[] = [],
): Candidate | null {
  let best: Candidate | null = null;
  let bestAt = Infinity;
  for (const machine of candidates) {
    if (!machine.online || machine.state !== "idle" || machine.paused || held.has(machine.id))
      continue;
    if (!hasLabels(machine.labels, wanted)) continue;
    const at = picked.get(machine.id) ?? -Infinity;
    if (at < bestAt) {
      best = machine;
      bestAt = at;
    }
  }
  return best;
}

/**
 * When every machine with the wanted labels is paused, their names; otherwise empty. A mix of
 * paused and busy or offline machines isn't "paused": unpausing wouldn't be enough on its own.
 */
export function pausedMatches(
  machines: { name: string; labels: string[]; paused?: boolean }[],
  wanted: string[] = [],
): string[] {
  const matching = machines.filter((machine) => hasLabels(machine.labels, wanted));
  if (matching.length === 0 || !matching.every((machine) => machine.paused)) return [];
  return matching.map((machine) => machine.name);
}

export interface QueuedJob {
  jobId: number;
  repositoryId: number;
  runId: number;
}

/** Whether a queued job may take a route: same repo and run, and not claimed by another job. */
export function canClaim(route: Route, job: QueuedJob) {
  if (route.repositoryId !== job.repositoryId || route.runId !== job.runId) return false;
  return route.jobId === undefined || route.jobId === job.jobId;
}

// GitHub runner names allow letters, digits, `.`, `-` and `_`. The machine's name comes first so
// the job's "Runner name" says which machine ran it; the route id keeps it unique in the org.
export function machineRunnerName(machineName: string, routeId: string) {
  const base =
    machineName
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "machine";
  return `${base}-${routeId}`;
}

// What the Router needs from a claimed job: its repo and run from the `github` context, and the
// relay's per-provider inputs from `inputs`.
export interface JobContext {
  repo: string;
  runId: number;
  // 1 for a run's first attempt. A full re-run picks again under a new attempt.
  runAttempt: number;
  // The workflow's name, or null when missing.
  workflow: string | null;
  // Labels a machine must all have. Empty when the relay's `machine` input is left out or empty:
  // the job doesn't use machines.
  machine: string[];
  // The GitHub-hosted runner label(s) from the relay's `github` input. Empty when left out.
  github: string[];
  // The Blacksmith runner label(s) from the relay's `blacksmith` input. Empty when left out.
  blacksmith: string[];
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
  const runAttempt = Number(scalar(github.get("run_attempt")));
  const workflow = scalar(github.get("workflow"));
  return {
    repo,
    runId,
    runAttempt: Number.isSafeInteger(runAttempt) && runAttempt > 0 ? runAttempt : 1,
    workflow: typeof workflow === "string" && workflow ? workflow : null,
    machine: parseLabels(scalar(inputs?.get("machine"))),
    github: parseLabels(scalar(inputs?.get("github"))),
    blacksmith: parseLabels(scalar(inputs?.get("blacksmith"))),
  };
}

// Why a step of the order didn't answer: not_configured (the relay left the provider's input
// empty), public_repo (machines never run a public repo's jobs), no_machine (no online, idle
// machine has every wanted label), too_many_labels (`github` or `blacksmith` names more than one
// label; a runs-on from an output holds one), not_blacksmith_label (`blacksmith` names a label
// Blacksmith doesn't serve, so the job would sit queued). Shared with the Activity page, which explains each.
export type { SkipReason } from "@relayrunner/activity";
import type { SkipReason } from "@relayrunner/activity";

export interface SkippedStep {
  key: RunnerKey;
  reason: SkipReason;
  // machine_paused: the paused machines' names.
  paused?: string[];
  // minutes_limit and minutes_runway: the job's GitHub account and its usage at the pick.
  minutes?: Omit<MinutesSkip, "reason">;
}

// What the machine step's pick found: a route label, every matching machine paused, or nothing.
export type MachinePick = string | { paused: string[] } | null;

// `notInOrder` lists providers the job configured that the order leaves out, either way, so an
// ignored input is never silent.
export type RouteDecision =
  // `step` answered with `runner`, after skipping `skipped` (in order).
  | { runner: string; step: RunnerKey; skipped: SkippedStep[]; notInOrder: RunnerKey[] }
  // Nothing fits: fail the relay with `reason`.
  | { runner: null; reason: string; skipped: SkippedStep[]; notInOrder: RunnerKey[] };

export interface RouteRequest {
  machine: string[];
  github: string[];
  blacksmith: string[];
  private: boolean;
}

// Blacksmith's runner labels all start with this, e.g. `blacksmith-2vcpu-ubuntu-2404`. Blacksmith
// has no API to ask whether it can take a job, so a Blacksmith step always accepts one with such a
// label; anything else would queue forever.
const BLACKSMITH_LABEL = /^blacksmith-/i;
export const isBlacksmithLabel = (label: string) => BLACKSMITH_LABEL.test(label);

/**
 * Walks the order top to bottom. A step whose provider the job didn't configure is skipped, and a
 * provider the job configures but the order leaves out is never tried. `pickMachine` is only
 * called when the machine step is reached and may run; it returns the route label, the paused
 * machines when every one that fits is paused, or null. `githubUsage` reads the job's GitHub
 * account's Actions minutes, and is only called when a GitHub step with a minutes limit is reached
 * (once per pick, however many such steps there are).
 */
export async function decideRoute(
  order: RunnerOrder,
  job: RouteRequest,
  pickMachine: () => Promise<MachinePick>,
  githubUsage: () => Promise<AccountUsage | null> = async () => null,
): Promise<RouteDecision> {
  const skipped: SkippedStep[] = [];
  let usage: Promise<AccountUsage | null> | undefined;
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
        if (pick && pick.paused.length > 0)
          skipped.push({ key, reason: "machine_paused", paused: pick.paused });
        else skipped.push({ key, reason: "no_machine" });
      }
    } else if (key === "github") {
      if (job.github.length === 0) skipped.push({ key, reason: "not_configured" });
      else if (job.github.length > 1) skipped.push({ key, reason: "too_many_labels" });
      else {
        const over = step.limit
          ? minutesCheck(await (usage ??= githubUsage()), step.limit.percent)
          : null;
        if (!over) return { runner: job.github[0], step: key, skipped, notInOrder };
        const { reason, ...minutes } = over;
        skipped.push({ key, reason, minutes });
      }
    } else if (key === "blacksmith") {
      if (job.blacksmith.length === 0) skipped.push({ key, reason: "not_configured" });
      else if (job.blacksmith.length > 1) skipped.push({ key, reason: "too_many_labels" });
      else if (!isBlacksmithLabel(job.blacksmith[0]))
        skipped.push({ key, reason: "not_blacksmith_label" });
      else return { runner: job.blacksmith[0], step: key, skipped, notInOrder };
    }
  }
  return { runner: null, reason: noRunnerReason(job, skipped, notInOrder), skipped, notInOrder };
}

/** The message a relay fails with when nothing fits, naming why each provider couldn't take it. */
export function noRunnerReason(
  job: RouteRequest,
  skipped: SkippedStep[],
  notInOrder: RunnerKey[],
): string {
  if (RUNNER_KEYS.every((key) => job[key].length === 0))
    return `${NO_RUNNER}: the relay sets none of \`machine\`, \`github\` or \`blacksmith\`.`;
  const parts = skipped.map(({ key, reason, paused = [], minutes }) => {
    switch (reason) {
      case "not_configured":
        return `\`${key}\` isn't set on this relay`;
      case "public_repo":
        return "public repos never run on self-hosted machines";
      case "no_machine":
        return job.machine.length === 1 && job.machine[0].toLowerCase() === "self-hosted"
          ? "no self-hosted machine is online and idle"
          : `no self-hosted machine with ${job.machine.join(", ")} is online and idle`;
      case "machine_paused":
        return paused.length === 1
          ? `the only machine that fits, ${paused[0]}, is paused`
          : `every machine that fits is paused (${paused.join(", ")})`;
      case "too_many_labels":
        return `\`${key}\` takes one label, not ${job[key].join(", ")}`;
      case "not_blacksmith_label":
        return `\`blacksmith\` takes a Blacksmith label such as blacksmith-2vcpu-ubuntu-2404, not ${job.blacksmith.join(", ")}`;
      case "minutes_limit":
      case "minutes_runway":
        return minutesText(reason, minutes);
    }
  });
  for (const key of notInOrder) parts.push(`${RUNNER_LABELS[key]} isn't in your runner order`);
  return `${NO_RUNNER}: ${parts.join("; ")}.`;
}

export const NO_RUNNER = "No runner available";

const count = (n: number) => Math.round(n).toLocaleString("en-US");

/** "relayrunner has used 1,640 of its 2,000 included minutes (82%), past the 80% limit". */
export function minutesText(
  reason: "minutes_limit" | "minutes_runway",
  minutes: SkippedStep["minutes"],
): string {
  if (!minutes) return "GitHub-hosted is past its minutes limit";
  const { account, usedMinutes, quotaMinutes, percent, burnRatePerHour } = minutes;
  const used = `${account} has used ${count(usedMinutes)} of its ${count(quotaMinutes)} included minutes (${Math.floor((usedMinutes / quotaMinutes) * 100)}%)`;
  return reason === "minutes_limit"
    ? `${used}, past the ${percent}% limit`
    : `${used}, and at ${count(burnRatePerHour ?? 0)} minutes an hour it could run out before GitHub's billing catches up`;
}
