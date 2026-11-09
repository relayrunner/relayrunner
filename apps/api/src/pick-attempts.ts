// How the pick runner (src/durable-objects/pick-runner.ts) retries a relay job. Kept apart from
// the Durable Object so it can be tested without the Workers runtime.

// How long one pick runner waits for a job.
export const WAIT_FOR_JOB_MS = 4 * 60_000;
// The first runner plus 3 replacements: a relay still queued after ~16 minutes is given up on.
export const MAX_ATTEMPTS = 4;
// A run that started longer ago than this was cut off (a deploy evicts the object mid-wait).
export const RUN_STALE_MS = WAIT_FOR_JOB_MS + 2 * 60_000;
const PICK_RUNNER_PREFIX = "relayrunner-pick-";

// Replacements get their own name, so one left registered can't block the next.
export function pickRunnerName(jobId: number, attempt = 1) {
  return attempt > 1 ? `${PICK_RUNNER_PREFIX}${jobId}-${attempt}` : `${PICK_RUNNER_PREFIX}${jobId}`;
}

/** The job id a pick runner was registered for, from its name, or null for any other runner. */
export function pickJobIdFromRunnerName(name: string) {
  const match = /^relayrunner-pick-(\d+)(?:-\d+)?$/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * What to do once a runner is done, from the status GitHub reports for the job it was made for.
 * Only a job that is still queued gets another runner, and only up to MAX_ATTEMPTS.
 */
export function afterAttempt(status: string | null, attempt: number) {
  if (status !== "queued") return "done" as const;
  return attempt < MAX_ATTEMPTS ? ("rearm" as const) : ("give_up" as const);
}
