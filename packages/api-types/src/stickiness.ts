// Whether a workspace stuck with the relay (apps/api/src/stickiness.ts), for the operator views.
export type StickinessState = "trying" | "adopted" | "trial_abandoned" | "removed";

export type Stickiness = {
  state: StickinessState;
  /** When the workspace entered this state. */
  since: string;
  /** The workflow the state is about: the latest relayed, or the last one removed. */
  repository: string;
  workflow: string;
  /** The branch that added the relay, while trying or after the trial was abandoned. */
  branch: string | null;
  lastRelayAt: string;
  /** Removed: runs on up-to-date code without the relay since the last relay. */
  runsWithout: number;
  /** Removed: when we first saw the run that made it so (for the operator ping). */
  removedSeenAt: string | null;
};
