// Where time goes inside a job: the API sorts each step GitHub reports into one of these by its
// name (apps/api/src/step-phases.ts), in the order they stack.
export type Phase = "setup" | "checkout" | "dependencies" | "cache" | "work" | "cleanup";

/** Milliseconds per phase; a phase with no time is left out. */
export type PhaseTimes = Partial<Record<Phase, number>>;
