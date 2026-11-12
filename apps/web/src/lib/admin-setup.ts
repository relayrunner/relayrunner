/** A workspace's setup steps for Admin › Workspaces (apps/api/src/admin-adoption.ts). */
export type Setup = {
  signedUpAt: string | null;
  installedAt: string | null;
  machineAt: string | null;
  firstMachineJobAt: string | null;
};

export const SETUP_STEPS = [
  { key: "signedUpAt", label: "Signed up" },
  { key: "installedAt", label: "App installed" },
  { key: "machineAt", label: "Machine connected" },
  { key: "firstMachineJobAt", label: "First job on a machine" },
] as const;

/** How long a step can wait after the one before it before it shows as stuck. */
export const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

export type SetupStep = {
  label: string;
  at: string | null;
  /** Not done, and the step before it happened over STUCK_AFTER_MS ago. */
  stuck: boolean;
  /** When the step before it happened, for a step not done yet. */
  waitingSince: string | null;
};

/** The workspace's setup steps in order, each done, stuck, or waiting. */
export function setupSteps(setup: Setup, now = Date.now()): SetupStep[] {
  let previous: string | null = null;
  return SETUP_STEPS.map(({ key, label }) => {
    const at = setup[key];
    const waitingSince = at ? null : previous;
    const stuck = !!waitingSince && now - new Date(waitingSince).getTime() > STUCK_AFTER_MS;
    previous = at;
    return { label, at, stuck, waitingSince };
  });
}
