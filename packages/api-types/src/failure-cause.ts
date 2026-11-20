// Why a job failed, in one word, from the AI model (apps/api/src/ai/failure-cause.ts).
export type FailureCauseKind = "flaky" | "lint" | "test" | "build" | "infra" | "config";

export type FailureCause = {
  kind: FailureCauseKind;
  /** How sure the model is of `kind`, from 0 to 1. */
  confidence: number;
  /** The chance that running the job again, with no change, passes. */
  passesOnRerun: number;
  /** What a re-run will likely do, when the answers are sure enough and agree; else null. */
  rerun: "passes" | "fails" | null;
};
