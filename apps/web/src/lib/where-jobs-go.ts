import type { RunnerKey, RunnerStep } from "@relayrunner/runner-order";
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
  const after = steps
    .slice(at + 1)
    .filter((step) => step.key !== "machine")
    .map((s) => NAMES[s.key]);
  const before = at > 0 ? steps.slice(0, at).map((s) => NAMES[s.key]) : [];
  const active = machines.filter((machine) => !machine.revokedAt);
  const ready = active.filter((machine) => machine.status?.online && !machine.paused);

  if (at === -1)
    return { tone: "idle", text: "Self-hosted isn't in the Router, so jobs never run here." };
  if (active.length === 0)
    return {
      tone: "idle",
      text:
        before.length || after.length
          ? `No self-hosted runner yet, so jobs run on ${list([...before, ...after])}.`
          : "No self-hosted runner yet, so jobs that need one stop early.",
    };
  const elsewhere = after.length ? `jobs go to ${list(after)}` : "jobs that need one stop early";
  if (ready.length === 0)
    return {
      tone: "idle",
      text: `${active.length === 1 ? `${active[0]!.name} is offline` : "No runner is online"}, so ${elsewhere}.`,
    };
  const who =
    ready.length === 1
      ? `${ready[0]!.name} is online.`
      : `${ready.length} of ${active.length} runners online.`;
  if (before.length)
    return {
      tone: "go",
      text: `${who} Jobs try ${list(before)} first, then here${after.length ? `, then ${list(after)}` : ""}.`,
    };
  return {
    tone: "go",
    text: `${who} Private repo jobs run here${after.length ? `, with ${list(after)} as fallback` : ""}.`,
  };
}

// How the line names a provider.
const NAMES: Record<RunnerKey, string> = {
  machine: "self-hosted",
  github: "GitHub-hosted",
  blacksmith: "Blacksmith",
};

function list(labels: string[]) {
  if (labels.length <= 1) return labels[0] ?? "";
  return labels.join(", then ");
}
