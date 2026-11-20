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

// `not_routable`: a re-run job came back on its run's own `rr-<id>` label, but the Router can't
// route it again (no earlier pick it can use, or no machine whose labels and sharing allow it), so
// nothing would ever take it (src/webhook-queue.ts dispatchRoute).
// `orphaned`: a job still queued on its run's own `rr-<id>` label that the Router no longer has in
// hand, so nothing would ever take it (src/orphaned-jobs.ts, the */15 sweep).
export type StrandedReason = "no_machine" | "runner_failed" | "not_routable" | "orphaned";

// The error the ended job shows on its run. Retries read it back (strandedJob) as a runner failure:
// a retry re-runs the run's relay, which picks a runner again, so it doesn't hit the same dead end.
// Every message ends with how to recover: "Re-run failed jobs" reuses the run's old relay pick,
// while "Re-run all jobs" runs the relay again so it picks a runner that can take the job now.
const RECOVER =
  'To recover, use "Re-run all jobs" so the relay picks a new runner. "Re-run failed jobs" can hit the same problem.';

export const STRANDED_MESSAGES: Record<StrandedReason, string> = {
  no_machine: `No machine could take this job. The machine it was sent to went offline before the job started. ${RECOVER}`,
  runner_failed: `This job's runner failed to start on the machines it was sent to. ${RECOVER}`,
  not_routable: `RelayRunner couldn't route this job again. ${RECOVER}`,
  orphaned: `RelayRunner lost track of this job before a runner took it. ${RECOVER}`,
};

// Messages earlier versions wrote, so retries still recognize jobs ended before the wording changed.
const EARLIER_MESSAGES = [
  "No machine could take this job. The machine it was sent to went offline before the job started.",
  "This job's runner failed to start on the machines it was sent to.",
  "RelayRunner couldn't route this job again. Re-run all jobs so the relay picks a runner.",
  "RelayRunner lost track of this job before a runner took it. Re-run all jobs so the relay picks a runner.",
];

/** Whether GitHub's annotations on a job say it ended here because no runner could take it. */
export const strandedJob = (messages: string[]) =>
  messages.some(
    (message) =>
      Object.values(STRANDED_MESSAGES).includes(message) || EARLIER_MESSAGES.includes(message),
  );

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

/**
 * The StrandedJob that ends a route's job. By route and job, so a later attempt's re-run on the
 * same label (a new job id) can be ended too, while a redelivered webhook for the same job can't
 * end it twice.
 */
export function strandedJobName(routeId: string, jobId: number) {
  return `${routeId}:${jobId}`;
}

/** The name of the runner that ends a route's stranded job. */
export function strandedRunnerName(routeId: string) {
  return `relayrunner-end-${routeId}`;
}
