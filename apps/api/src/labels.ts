// A module of its own, with no imports, so modules on both sides of an import cycle (job-times.ts
// and webhook-queue.ts) can read it while they load.

/** The `runs-on` label that routes a job through RelayRunner. */
export const RELAYRUNNER_LABEL = "relayrunner";
