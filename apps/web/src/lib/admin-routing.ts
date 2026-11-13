import { api } from "@/lib/api";

/** Routing health across workspaces, for Admin › Routing (apps/api/src/admin-routing.ts). */
export type RoutingRange = "24h" | "7d";

export const ROUTING_RANGES: { value: RoutingRange; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];

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
  public_repo: "public repo",
  not_configured: "not set on the relay",
  too_many_labels: "more than one label",
  not_provider_label: "label isn't the provider's",
  minutes_limit: "over the minutes limit",
  minutes_runway: "minutes running out",
  provider_unhealthy: "not picking up jobs",
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

/** Made-up data for the dev server without sign-in (VITE_AUTH_DISABLED). */
export function sampleRoutingHealth(range: RoutingRange): RoutingHealth {
  const bucketMs = range === "24h" ? 3_600_000 : 6 * 3_600_000;
  const count = range === "24h" ? 24 : 28;
  const to = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const from = to - count * bucketMs;
  const noise = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  const buckets: RoutingBucket[] = Array.from({ length: count }, (_, i) => {
    const hour = new Date(from + i * bucketMs).getHours();
    const busy = range === "7d" || (hour >= 9 && hour < 19);
    const spike = range === "24h" ? hour === 14 : i === count - 4;
    const scale = range === "24h" ? 1 : 5;
    return {
      start: new Date(from + i * bucketMs).toISOString(),
      routed: Math.round((busy ? 60 + noise(i) * 30 : 15 + noise(i) * 15) * scale),
      queued: spike ? 12 * scale : busy ? Math.round(noise(i + 3) * 4 * scale) : 0,
      unroutable: spike ? 14 : noise(i + 7) > 0.85 ? 1 : 0,
      peakWaiting: spike ? 11 : busy ? Math.round(noise(i + 5) * 3) : 0,
      p95WaitMs: spike ? 22 * 60_000 : busy ? Math.round((1 + noise(i + 9) * 4) * 60_000) : null,
    };
  });
  const sum = (key: "routed" | "queued" | "unroutable") =>
    buckets.reduce((total, bucket) => total + bucket[key], 0);
  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketMs,
    totals: {
      relays: sum("routed") + sum("queued") + sum("unroutable"),
      routed: sum("routed"),
      queued: sum("queued"),
      unroutable: sum("unroutable"),
      unroutableWorkspaces: 3,
      p95WaitMs: 11 * 60_000,
      waitingNow: 4,
      oldestWaitingMs: 6 * 60_000,
    },
    buckets,
    reasons: [
      { kind: "routing", provider: "machine", reason: "no_machine", count: 9 },
      { kind: "routing", provider: "github", reason: "not_configured", count: 9 },
      { kind: "setup", provider: null, reason: "runner_group", count: 3 },
      { kind: "routing", provider: "machine", reason: "machine_paused", count: 1 },
      { kind: "routing", provider: "github", reason: "minutes_limit", count: 1 },
    ],
    workspaces: [
      {
        id: "w1",
        name: "Cabal",
        slug: "cabal",
        relays: 214,
        queued: 41,
        unroutable: 9,
        p95WaitMs: 22 * 60_000,
        topReason: { kind: "routing", provider: "machine", reason: "no_machine" },
      },
      {
        id: "w2",
        name: "Sandpiper",
        slug: "sandpiper",
        relays: 96,
        queued: 6,
        unroutable: 3,
        p95WaitMs: 5 * 60_000,
        topReason: { kind: "setup", provider: null, reason: "runner_group" },
      },
      {
        id: "w3",
        name: "Tidewater",
        slug: "tidewater",
        relays: 388,
        queued: 14,
        unroutable: 0,
        p95WaitMs: 8 * 60_000,
        topReason: null,
      },
      {
        id: "w4",
        name: "Northfold",
        slug: "northfold",
        relays: 151,
        queued: 1,
        unroutable: 0,
        p95WaitMs: 60_000,
        topReason: null,
      },
    ],
  };
}
