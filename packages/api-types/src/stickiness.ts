// Whether a workspace stuck with the relay (apps/api/src/routing/stickiness.ts), for the operator views.
export type StickinessState = "trying" | "adopted" | "trial_abandoned" | "removed";

export type Stickiness = {
  state: StickinessState;
  /** When the workflow below entered this state. Removed: when we could first tell. */
  since: string;
  /** The workflow the state is about: the latest relayed, or the last one removed. */
  repository: string;
  workflow: string;
  /** The branch that added the relay, while trying or after the trial was abandoned. */
  branch: string | null;
  lastRelayAt: string;
  /** Removed: runs on up-to-date code without the relay since the last relay. */
  runsWithout: number;
};
