import { api } from "@/lib/api";
/** Routing health across workspaces, for Admin › Routing (apps/api/src/operator/admin-routing.ts). */
export type RoutingRange = "24h" | "7d";

export const ROUTING_RANGES: RoutingRange[] = ["24h", "7d"];

export type SetupReason =
  | "install_suspended"
  | "no_repo_access"
  | "runner_group"
  | "unreadable_job"
  | "other";

/** What kept a relay from routing, without its count. */
export type ReasonKey =
  | { kind: "routing"; provider: string; reason: string }
  | { kind: "setup"; provider: null; reason: SetupReason };

export type UnroutableReason = ReasonKey & { count: number };

export type RoutingBucket = {
  start: string;
  routed: number;
  queued: number;
  unroutable: number;
  peakWaiting: number;
  p95WaitMs: number | null;
};

export type RoutingWorkspace = {
  id: string;
  name: string;
  slug: string;
  relays: number;
  queued: number;
  unroutable: number;
  p95WaitMs: number | null;
  topReason: ReasonKey | null;
};

export type RoutingHealth = {
  range: RoutingRange;
  from: string;
  to: string;
  bucketMs: number;
  totals: {
    relays: number;
    routed: number;
    queued: number;
    unroutable: number;
    unroutableWorkspaces: number;
    p95WaitMs: number | null;
    waitingNow: number;
    oldestWaitingMs: number | null;
  };
  buckets: RoutingBucket[];
  reasons: UnroutableReason[];
  workspaces: RoutingWorkspace[];
};

export function getRoutingHealth(range: RoutingRange) {
  return api<RoutingHealth>(`/admin/routing?range=${range}`);
}

// A wait at or above this is worth a look, the same line the Slack ping would use.
export const LONG_WAIT_MS = 15 * 60 * 1000;

const PROVIDER_NAMES: Record<string, string> = {
  machine: "Machines",
  github: "GitHub-hosted",
};

const ROUTING_REASONS: Record<string, string> = {
  no_machine: "no machine online and idle",
  machine_full: "every machine full",
  machine_paused: "machine paused",
  machine_not_shared: "machine only runs its owner's jobs",
  github_rate_limited: "GitHub API limit reached",
  public_repo: "public repo",
  personal_account: "personal account",
  not_configured: "not set on the relay",
  no_size: "no runner that size",
  too_many_labels: "more than one label",
  not_provider_label: "label isn't the provider's",
  minutes_limit: "over the minutes limit",
  minutes_runway: "minutes running out",
  provider_unhealthy: "not picking up jobs",
  spend_limit: "over the spend limit",
  start_limit: "out of job starts",
  provider_held: "provider would hold it",
  provider_no_access: "provider can't see the repo",
  not_in_order: "not in the runner order",
};

const SETUP_REASONS: Record<SetupReason, string> = {
  install_suspended: "GitHub App install suspended",
  no_repo_access: "No access to the repo",
  runner_group: "Runner group leaves the repo out",
  unreadable_job: "Couldn't read the job",
  other: "Other setup problem",
};

const providerName = (key: string) =>
  PROVIDER_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

/** "Machines: no machine online and idle", or a setup problem's own words. */
export function reasonText(reason: ReasonKey) {
  if (reason.kind === "setup") return SETUP_REASONS[reason.reason];
  return `${providerName(reason.provider)}: ${ROUTING_REASONS[reason.reason] ?? reason.reason.replaceAll("_", " ")}`;
}

/** The reason's code, as the API and logs spell it. */
export const reasonCode = (reason: ReasonKey) =>
  reason.kind === "setup" ? reason.reason : `${reason.provider}.${reason.reason}`;
