// Jobs sent to a connected machine that never started there. GitHub hands a queued job to a runner
// with its `rr-<id>` label, and only the runner minted for the route has that label, so when the
// machine drops (quit, sleep, Wi-Fi, crash) or its runner fails to start, the job would sit queued
// for GitHub's 24 hours. Instead it goes back in the Router's line for another runner on the same
// label (MachineLink notices, Router.requeueSent puts it back), and a job no machine can take ends
// with the reason (StrandedJob), so the run finishes and automatic retries can pick again.

import type { Db } from "./db/index.ts";
import { workflowJobStatus } from "./github-app.ts";
import { startedJobStatus } from "./jobs.ts";

// How long a machine may be gone before a job sent to it and not yet started goes elsewhere. A
// deploy reconnects every machine within seconds, and a short Wi-Fi drop keeps the runner itself
// connected to GitHub, so neither moves a job.
export const LOST_GRACE_MS = 60_000;
// How many times one job goes back in line before it ends instead, so a machine whose runner
// always fails can't bounce it forever.
export const MAX_REQUEUES = 2;
// How long a queued job waits with no machine online that could take it before it ends. Machines
// that are only full keep it waiting, like any job for a busy self-hosted runner.
export const NO_MACHINE_GIVE_UP_MS = 5 * 60_000;

export type StrandedReason = "no_machine" | "runner_failed";

// The error the ended job shows on its run. Retries read it back (strandedJob) as a runner failure.
export const STRANDED_MESSAGES: Record<StrandedReason, string> = {
  no_machine:
    "No machine could take this job. The machine it was sent to went offline before the job started.",
  runner_failed: "This job's runner failed to start on the machines it was sent to.",
};

/** Whether GitHub's annotations on a job say it ended here because no runner could take it. */
export const strandedJob = (messages: string[]) =>
  messages.some((message) => Object.values(STRANDED_MESSAGES).includes(message));

/**
 * Whether a job is still waiting for a runner: not started by its webhooks, and queued as GitHub
 * has it now. GitHub is only asked when the webhooks haven't said it started.
 */
export async function jobStillQueued(
  db: Db,
  token: () => Promise<string>,
  repo: string,
  jobId: number,
): Promise<boolean> {
  if (await startedJobStatus(db, jobId)) return false;
  return (await workflowJobStatus(await token(), repo, jobId)) === "queued";
}

/** The name of the runner that ends a route's stranded job. */
export function strandedRunnerName(routeId: string) {
  return `relayrunner-end-${routeId}`;
}
