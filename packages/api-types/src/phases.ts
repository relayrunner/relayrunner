// Where time goes inside a job: the API sorts each step GitHub reports by its name
// (apps/api/src/reports/step-phases.ts) into a setup item or a kind of work.

/** Setup: what a job does every run to get the machine ready, in the order it stacks. */
export type SetupItem =
  | "runner"
  | "checkout"
  | "tools"
  | "packages"
  | "system"
  | "browsers"
  | "images"
  | "cache";

/** Setup a cache step can cover; the rest runs every time anyway. */
export const CACHEABLE = [
  "packages",
  "system",
  "browsers",
  "images",
] as const satisfies readonly SetupItem[];

/** The job's own work: what a step's name says, else what its job's type says. */
export type WorkKind = "build" | "test" | "other";

export type Part = SetupItem | WorkKind;

/** Milliseconds per part; a part with no time is left out. */
export type PartTimes = Partial<Record<Part, number>>;
