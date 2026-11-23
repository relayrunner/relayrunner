// Why a job failed, in one word, from what job-failures.ts already read from GitHub: the failed
// step, the annotations and the end of the log. Advisory only: nothing acts on it yet.
import type { FailureCause, FailureCauseKind } from "@relayrunner/api-types";
import type { Env } from "../env.ts";
import type { JobFailure } from "../reports/job-failures.ts";
import { classify, defineClassifier } from "./classify.ts";

export const FAILURE_CAUSES = {
  flaky: "Intermittent: a timeout, network error, race or test that would pass if run again",
  lint: "A lint, format or type check found problems in the code",
  test: "A test failed because of a change in the code",
  build: "Compiling, bundling or installing dependencies failed",
  infra: "The runner or its environment broke: out of disk or memory, lost runner, service down",
  config: "The workflow or its setup is wrong: bad YAML, missing secret, permission or tool",
  unclear: "There isn't enough to tell, or it could be several of these",
} as const satisfies Record<FailureCauseKind | "unclear", string>;
// "unclear" is how the model says it isn't sure; it's never given as a cause.
export type { FailureCause, FailureCauseKind };

// Jev, the first model, ran overconfident: it called a failed deep-equal test "flaky" at 74%. These
// thresholds are kept for Clef-flash until real failures say otherwise. Causes below
// SHOWN aren't given, and a re-run verdict needs a sure answer that agrees with the cause.
const SHOWN = 0.7;
const SURE = 0.85;
const PASSES_ON_RERUN: ReadonlySet<FailureCauseKind> = new Set(["flaky", "infra"]);

function rerunVerdict(kind: FailureCauseKind, confidence: number, passesOnRerun: number) {
  if (confidence < SURE) return null;
  const transient = PASSES_ON_RERUN.has(kind);
  if (transient && passesOnRerun >= SURE) return "passes";
  if (!transient && passesOnRerun <= 1 - SURE) return "fails";
  return null;
}

/** What the model reads about a failure. */
type FailureInput = Pick<
  JobFailure,
  "name" | "failedStep" | "runnerFailed" | "annotations" | "log"
>;

// Lines of the excerpt the model sees: the error is at its end.
const LOG_LINES = 30;

// Ids, hashes, durations, ports and paths with numbers vary between runs of the same failure, so
// they're left out of the cache key. Two jobs failing on the same error then cost one call.
const VARYING = /\b(?:[0-9a-f]{7,}|\d+(?:\.\d+)?(?:ms|s|m)?)\b/gi;
const normalize = (line: string) => line.replace(VARYING, "#").replace(/\s+/g, " ").trim();

const failureCause = defineClassifier({
  feature: "failure_cause",
  version: 3,
  questions: {
    cause: {
      type: "choice",
      instructions: "What most likely made this CI job fail?",
      criteria: FAILURE_CAUSES,
    },
    rerun: {
      type: "noul",
      instructions: "Would running this job again, with no change to the code, most likely pass?",
      criteria: {
        true: "The failure looks intermittent or caused by the runner or a service",
        false:
          "The failure comes from the code or the workflow and would happen again, such as a failed assertion",
      },
    },
  },
  state: (failure: FailureInput) => ({
    job: failure.name,
    failed_step: failure.failedStep,
    runner_failed_before_any_step: failure.runnerFailed,
    annotations: failure.annotations,
    log_end: failure.log?.slice(-LOG_LINES) ?? [],
  }),
  cacheKey: (failure) => ({
    step: failure.failedStep?.replace(/^\d+\. /, ""),
    runnerFailed: failure.runnerFailed,
    annotations: failure.annotations.map(normalize),
    log: failure.log?.slice(-LOG_LINES).map(normalize) ?? [],
  }),
});

/**
 * The likely cause of one failure, or null when AI is off for the workspace, the model said no or
 * isn't sure, or there's nothing to go on (no log and no annotations).
 */
export async function failureCauseOf(
  env: Env,
  workspaceId: string,
  failure: FailureInput,
): Promise<FailureCause | null> {
  if (!failure.log?.length && !failure.annotations.length && !failure.runnerFailed) return null;
  const result = await classify(env, failureCause, workspaceId, failure);
  if (!result.ok) return null;
  const { cause, rerun } = result.answers;
  if (cause.choice === "unclear" || cause.confidence < SHOWN) return null;
  return {
    kind: cause.choice,
    confidence: cause.confidence,
    passesOnRerun: rerun.noul,
    rerun: rerunVerdict(cause.choice, cause.confidence, rerun.noul),
  };
}
