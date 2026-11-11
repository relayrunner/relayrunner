// Container runners: a real runner for jobs that ask for `runs-on: relayrunner-container`. Each
// queued job gets a ContainerRunner Durable Object (src/durable-objects/container-runner.ts),
// which mints a one-job JIT runner on that label and boots a Cloudflare Container with it. The
// container runs GitHub's runner, takes one job and exits. Kept free of Durable Object APIs so the
// decisions can be tested on their own.

import { hasLabels, parseLabels } from "./routing.ts";

// The `runs-on` label a job uses to run in a container.
export const CONTAINER_LABEL = "relayrunner-container";

// How long a container may wait for its job before it's stopped. GitHub offers a queued job within
// seconds once a runner with its label is online.
export const IDLE_LIMIT_MS = 10 * 60_000;
// The longest a container runs, job included.
export const MAX_LIFETIME_MS = 60 * 60_000;
// How often the Durable Object checks on its container.
export const WATCH_INTERVAL_MS = 60_000;

// The runner group container runners join when the org has one by this name: one-job, disposable
// runners only, so it may allow public repos. Without it they join Default, which in most orgs
// allows private repos only.
export const CONTAINER_RUNNER_GROUP = "Default Public";

/** The id of the group named CONTAINER_RUNNER_GROUP (case-insensitive), or the fallback. */
export function containerRunnerGroupId(groups: { id: number; name: string }[], fallback: number) {
  const wanted = CONTAINER_RUNNER_GROUP.toLowerCase();
  return groups.find((group) => group.name.toLowerCase() === wanted)?.id ?? fallback;
}

export const usesContainerRunner = (labels: string[]) => hasLabels(labels, [CONTAINER_LABEL]);

/**
 * Whether an org may start container runners: it's in the comma-separated CONTAINER_RUNNER_ORGS.
 * Unset or empty allows none, since every container is billed to our account.
 */
export function containerRunnerAllowed(allowed: string | undefined, org: string) {
  return hasLabels(parseLabels(allowed), [org]);
}

// The JIT runner as GitHub lists it: busy with the job, online waiting for one, or gone (GitHub
// removes a JIT runner once its job is done).
export type RunnerState = "busy" | "idle" | "gone";

// What a check on a container decides: it exited (done), keep watching (wait), or stop it.
export type WatchStep = "done" | "wait" | "stop_finished" | "stop_idle" | "stop_timeout";

export function watchStep(check: {
  running: boolean;
  runner: RunnerState;
  startedAt: number;
  now: number;
}): WatchStep {
  if (!check.running) return "done";
  const age = check.now - check.startedAt;
  if (age > MAX_LIFETIME_MS) return "stop_timeout";
  if (check.runner === "gone") return "stop_finished";
  if (check.runner === "idle" && age > IDLE_LIMIT_MS) return "stop_idle";
  return "wait";
}
