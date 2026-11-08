import type { RunnerKey, RunnerStep } from "@relayrunner/runner-order";
import { deviceName } from "./device";
import type { Machine } from "./machines";

/**
 * The one line at the top of the Runners page: where a private repo's job goes right now, from the
 * saved order and which self-hosted runners can take work. `tone` is "go" while a runner is ready.
 */
export function whereJobsGo(
  steps: RunnerStep[],
  machines: Machine[],
): { tone: "go" | "idle"; text: string } {
  const at = steps.findIndex((step) => step.key === "machine");
  const others = steps.filter((step) => step.key !== "machine").map((s) => NAMES[s.key]);
  const after = steps
    .slice(at + 1)
    .filter((step) => step.key !== "machine")
    .map((s) => NAMES[s.key]);
  const before = at > 0 ? steps.slice(0, at).map((s) => NAMES[s.key]) : [];
  const active = machines.filter((machine) => !machine.revokedAt);
  const ready = active.filter((machine) => machine.status?.online && !machine.paused);

  if (at === -1)
    return {
      tone: "idle",
      text: `Self-hosted isn't in the Router, so jobs run on ${list(others)} and never here.`,
    };
  const fallback = after.length > 0 ? `they go to ${list(after)}` : "jobs that need one stop early";
  if (active.length === 0)
    return {
      tone: "idle",
      text: before.length
        ? `No self-hosted runner yet. Jobs run on ${list(before)}${after.length ? `, then ${list(after)}` : ""}.`
        : after.length
          ? `No self-hosted runner yet, so jobs run on ${list(after)}.`
          : "No self-hosted runner yet, so jobs that need one stop early.",
    };
  if (ready.length === 0)
    return {
      tone: "idle",
      text: `${active.length === 1 ? `${title(active[0]!)} is` : "No runner is"} ${active.length === 1 ? "offline" : "online"}, so ${after.length ? `jobs go to ${list(after)}` : "jobs that need one stop early"}.`,
    };
  const who =
    ready.length === 1
      ? `${title(ready[0]!)} is online.`
      : `${ready.length} of ${active.length} runners are online.`;
  if (before.length)
    return {
      tone: "go",
      text: `${who} Jobs try ${list(before)} first, then these runners${after.length ? `, then ${list(after)}` : ""}.`,
    };
  return { tone: "go", text: `${who} Private repo jobs run here. When none is free, ${fallback}.` };
}

// How the line names a provider.
const NAMES: Record<RunnerKey, string> = {
  machine: "self-hosted runners",
  github: "GitHub-hosted runners",
  blacksmith: "Blacksmith",
};

// "Your MacBook Pro" reads better than a hostname, when the CLI said what the device is.
function title(machine: Machine) {
  const name = machine.device ? deviceName(machine.device) : null;
  return name && machine.source !== "github" ? `${machine.name} (${name})` : machine.name;
}

function list(labels: string[]) {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and then ${labels.at(-1)}`;
}
