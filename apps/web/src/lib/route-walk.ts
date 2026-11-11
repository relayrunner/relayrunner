import type { MinutesUsage, NotSharedMachine, RouteWalk, SkipReason } from "@relayrunner/activity";
import { notProviderLabelText, RUNNER_LABELS, type RunnerKey } from "@relayrunner/runner-order";

// How the Activity page explains where a job went: a short reason after the runner, and one line
// per step when the reason is opened. Worded here from the stored walk, so the copy can change
// without touching stored data.

export type { RouteWalk } from "@relayrunner/activity";

const ANY_MACHINE = "self-hosted";

// `machine: self-hosted` asks for any machine, so its labels add nothing to the sentence.
function machineLabels(walk: RouteWalk) {
  const labels = walk.machine.filter((label) => label.toLowerCase() !== ANY_MACHINE);
  return labels.length ? labels.join(", ") : null;
}

// "atticus-mbp is paused", "a and b are paused", "3 machines are paused".
function pausedText(paused: string[] = []) {
  if (paused.length === 1) return `${paused[0]} is paused`;
  if (paused.length === 2) return `${paused[0]} and ${paused[1]} are paused`;
  return paused.length ? `${paused.length} machines are paused` : "machines are paused";
}

// "atticus-mbp only runs Atticus's jobs"; for several, the short form counts them.
function notSharedText(notShared: NotSharedMachine[] = [], short = false) {
  const [only] = notShared;
  if (notShared.length === 1 && only) {
    const { machine, owner } = only;
    return `${machine} only runs ${owner ? `${owner}'s` : "its owner's"} jobs`;
  }
  if (notShared.length === 0) return "no machine takes this job";
  if (short || notShared.length > 3)
    return `${notShared.length} machines only run their owners' jobs`;
  const names = notShared.map((m) => m.machine);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} only run their owners' jobs`;
}

const count = (n: number) => Math.round(n).toLocaleString("en-US");
const usedPercent = (m: MinutesUsage) => Math.floor((m.usedMinutes / m.quotaMinutes) * 100);

function shortSkip(
  walk: RouteWalk,
  key: RunnerKey,
  reason: SkipReason,
  paused?: string[],
  minutes?: MinutesUsage,
  notShared?: NotSharedMachine[],
): string | null {
  switch (reason) {
    case "minutes_limit":
      return minutes
        ? `${minutes.account} at ${usedPercent(minutes)}% of GitHub minutes`
        : "past the GitHub minutes limit";
    case "minutes_runway":
      return minutes
        ? `${minutes.account} near its GitHub minutes limit`
        : "near the GitHub minutes limit";
    case "machine_paused":
      return pausedText(paused);
    case "machine_not_shared":
      return notSharedText(notShared, true);
    case "no_machine": {
      const labels = machineLabels(walk);
      return labels ? `no idle machine with ${labels}` : "no idle machine";
    }
    case "public_repo":
      return "public repo";
    case "too_many_labels":
      return `${key} takes one label`;
    case "not_provider_label":
      return `not a ${RUNNER_LABELS[key]} label`;
    case "not_configured":
      // Leaving a provider out of the relay is a choice, not news.
      return null;
  }
}

function longSkip(
  walk: RouteWalk,
  key: RunnerKey,
  reason: SkipReason,
  paused: string[] = [],
  minutes?: MinutesUsage,
  notShared?: NotSharedMachine[],
): string {
  switch (reason) {
    case "minutes_limit":
    case "minutes_runway": {
      if (!minutes) return "past its minutes limit";
      const used = `${minutes.account} has used ${count(minutes.usedMinutes)} of ${count(minutes.quotaMinutes)} included minutes (${usedPercent(minutes)}%)`;
      return reason === "minutes_limit"
        ? `${used}, past the ${minutes.percent}% limit`
        : `${used}; at ${count(minutes.burnRatePerHour ?? 0)} min/hour it could run out before billing catches up`;
    }
    case "machine_paused": {
      const labels = machineLabels(walk);
      const fits = labels ? `with ${labels}` : "that fits";
      return paused.length === 1
        ? `the only machine ${fits}, ${paused[0]}, is paused`
        : `every machine ${fits} is paused (${paused.join(", ")})`;
    }
    case "machine_not_shared":
      return notSharedText(notShared);
    case "no_machine": {
      const labels = machineLabels(walk);
      return labels
        ? `no machine with ${labels} was online and idle`
        : "no machine was online and idle";
    }
    case "public_repo":
      return "public repos never run on self-hosted machines";
    case "too_many_labels":
      return `${key} takes one label, not ${walk[key].join(", ")}`;
    case "not_provider_label":
      return `${key} ${notProviderLabelText(key, walk[key])}`;
    case "not_configured":
      return `the relay doesn't set ${key}`;
  }
}

export type WalkTone = "fallback" | "info";

/**
 * The short reason shown after a routed job's runner, or null when there's nothing to say (the
 * first step the relay set took it, and nothing it set was ignored). `fallback` when a step the
 * relay asked for couldn't take the job.
 */
export function walkSummary(walk: RouteWalk): { text: string; tone: WalkTone } | null {
  const parts: string[] = [];
  let tone: WalkTone = "info";
  for (const { key, reason, paused, minutes, notShared } of walk.skipped) {
    const text = shortSkip(walk, key, reason, paused, minutes, notShared);
    if (text) parts.push(text);
    if (reason !== "not_configured" && reason !== "public_repo") tone = "fallback";
  }
  for (const key of walk.notInOrder) parts.push(`${key} is set but not in your order`);
  return parts.length ? { text: parts.join("; "), tone } : null;
}

export interface WalkLine {
  // The step's place in the runner order, or null for a provider outside it.
  position: number | null;
  key: RunnerKey;
  state: "skipped" | "ran" | "not_tried";
  text: string;
}

/**
 * One line per step the pick looked at, in order, then the providers the order leaves out.
 * `runner` names where the answering step sent the job: its line reads "on <runner>".
 */
export function walkLines(walk: RouteWalk, runner: string | null): WalkLine[] {
  const lines: WalkLine[] = walk.skipped.map(
    ({ key, reason, paused, minutes, notShared }, index) => ({
      position: index + 1,
      key,
      state: "skipped",
      text: longSkip(walk, key, reason, paused, minutes, notShared),
    }),
  );
  if (walk.step)
    lines.push({
      position: lines.length + 1,
      key: walk.step,
      state: "ran",
      text: runner ? `on ${runner}` : "",
    });
  for (const key of walk.notInOrder)
    lines.push({ position: null, key, state: "not_tried", text: "not in your runner order" });
  return lines;
}

export const NO_RUNNER_PREFIX = "No runner available: ";

/** A failed relay's message without the "No runner available:" GitHub shows it with. */
export function failureText(reason: string) {
  const text = reason.startsWith(NO_RUNNER_PREFIX) ? reason.slice(NO_RUNNER_PREFIX.length) : reason;
  return text.replace(/`/g, "").replace(/\.$/, "");
}

/**
 * Job names as a phrase: "build", "build and test", "build, test and deploy", or "build, test and 3
 * more" past three. Null for none.
 */
export function jobNames(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0] ?? null;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
