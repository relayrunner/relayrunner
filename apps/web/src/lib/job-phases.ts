// Where time goes inside jobs: the API sorts each step GitHub reports into a phase by its name
// (apps/api/src/step-phases.ts). These are the phases' labels and colors, in the order they stack.

import type { Phase, PhaseTimes } from "@relayrunner/api-types";

export type { Phase, PhaseTimes };

const PHASE_LABELS = {
  setup: "Setup",
  checkout: "Checkout",
  dependencies: "Installs",
  cache: "Cache",
  work: "Work",
  cleanup: "Cleanup",
} satisfies Record<Phase, string>;

export const PHASE_ORDER = Object.keys(PHASE_LABELS) as Phase[];

export const phaseLabel = (phase: Phase) => PHASE_LABELS[phase];

export const phaseColor = (phase: Phase) => `var(--phase-${phase})`;

/** Adds `from`'s time into `into`. */
export function addPhases(into: PhaseTimes, from: PhaseTimes) {
  for (const phase of PHASE_ORDER) {
    const ms = from[phase];
    if (ms) into[phase] = (into[phase] ?? 0) + ms;
  }
  return into;
}

/** Steps' time added up by phase. */
export function phasesOf(steps: { phase: Phase; ms: number }[]) {
  const phases: PhaseTimes = {};
  for (const step of steps) phases[step.phase] = (phases[step.phase] ?? 0) + step.ms;
  return phases;
}

export const phaseTotal = (phases: PhaseTimes) =>
  PHASE_ORDER.reduce((sum, phase) => sum + (phases[phase] ?? 0), 0);

/** The share of step time outside the job's own work, 0 to 1; null without step time. */
export function overhead(phases: PhaseTimes) {
  const total = phaseTotal(phases);
  return total ? (total - (phases.work ?? 0)) / total : null;
}
