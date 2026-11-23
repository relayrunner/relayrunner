// Jobs the Router sent to a hosted provider that never picked them up. A provider's GitHub App
// only sees the repos it's installed on: one installed on "Selected repositories" without this
// repo, or not installed at all, leaves the job queued on its label for GitHub's 24 hours, and
// GitHub won't say which repos another App can see. So a routed job still queued on a provider's
// label a minute after it queued is taken over (ProviderTakeover): a one-job runner of ours on the
// same label claims it and ends it with the reason, the Router skips that provider for the repo
// (Router.providerMissed), and once the run finishes its relay is re-run, so the pick goes to the
// next provider in the order. Nobody has to notice or press anything.
//
// Before a job ever goes there, the Router also skips a provider whose GitHub App isn't installed
// on the job's account at all (Router.checkAccess).

import { RUNNER_LABELS } from "@relayrunner/runner-order";
import type { HostedProviderId } from "@relayrunner/providers";
import type { ProviderAccess } from "@relayrunner/activity";
import { FIRST_BACKOFF_MS, MAX_BACKOFF_MS, TRIAL_TIMEOUT_MS } from "./provider-health.ts";

// How long a routed job may wait on a provider's label before it's taken over. Flex runners that
// wait for spare room may need longer (a follow-up).
export const TAKEOVER_AFTER_MS = 60_000;
// How long the takeover's runner waits for GitHub to offer it the job.
export const TAKEOVER_WAIT_MS = 2 * 60_000;
// How often the takeover asks whether the run finished, so its relay can be re-run, and for how
// long. GitHub refuses a re-run while any job of the run is still going.
export const RERUN_POLL_MS = 30_000;
export const RERUN_GIVE_UP_MS = 6 * 60 * 60_000;
// A run is re-run this many times at most for missed jobs, so a provider that never picks up
// can't loop it.
export const MAX_TAKEOVER_ATTEMPT = 3;
// How long a provider's GitHub App installations are trusted for an account.
export const APPS_TTL_MS = 5 * 60_000;
// The providers whose GitHub App slug APP_SLUG_PATTERNS is known to match, from a real install. A
// pattern that missed a provider's real slug would skip it for every job, so the others are left
// to the takeover.
export const APP_CHECKED: readonly HostedProviderId[] = ["blacksmith", "groundbox"];

/** The error the taken-over job shows on its run. */
export function takeoverMessage(key: HostedProviderId): string {
  const name = RUNNER_LABELS[key];
  return `${name} didn't pick up this job within a minute, so RelayRunner ended it and is re-running the relay to pick another runner. ${name}'s GitHub App may not have access to this repository: check the repositories it can access in your GitHub settings.`;
}

/** The ProviderTakeover for a job. One per job, so a redelivered webhook can't take it twice. */
export const takeoverName = (jobId: number) => `takeover:${jobId}`;

/** The name of the runner that takes a job over. */
export const takeoverRunnerName = (jobId: number) => `relayrunner-move-${jobId}`;

/** The Router's storage id for a provider's misses in one repo. */
export const missId = (key: string, repositoryId: number) => `${key}:${repositoryId}`;

/** A provider that missed a job of one repo: skipped there until `retryAt`, then one trial. */
export interface RepoMiss {
  missedAt: number;
  retryAt: number;
  backoffMs: number;
  // When the trial job went, or null while none is out.
  trialAt: number | null;
}

/** The state after a miss: the first starts the backoff, a missed trial doubles it. */
export function missed(state: RepoMiss | undefined, now: number): RepoMiss {
  const backoffMs = state ? Math.min(state.backoffMs * 2, MAX_BACKOFF_MS) : FIRST_BACKOFF_MS;
  return { missedAt: now, retryAt: now + backoffMs, backoffMs, trialAt: null };
}

/** What a pick does with a provider for a repo: take it, take it as the trial, or skip it. */
export function missGate(
  state: RepoMiss | undefined,
  now: number,
): "ok" | "trial" | ProviderAccess {
  if (!state) return "ok";
  if (now >= state.retryAt && (state.trialAt === null || now - state.trialAt >= TRIAL_TIMEOUT_MS))
    return "trial";
  return { cause: "missed", retryAt: state.retryAt };
}
