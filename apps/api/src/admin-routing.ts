/**
 * Routing health for Admin › Routing: how relays ended across every workspace (got a runner right
 * away, queued for a full machine, or couldn't route), why they couldn't, and how long jobs waited
 * for a machine. Reads tables we already keep, each through an index over the window:
 * route_decision (relays that got a runner, and whether they waited), activity_event's
 * `job.unroutable` (relays that failed, with or without a walk down the runner order), and
 * workflow_job (when each job on a machine's `rr-` label was queued and started). Our own
 * workspaces and test accounts' are left out, as in the operator pings.
 */
import { and, eq, gte } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { internalWorkspaceIds } from "./internal-workspaces.ts";
import { testAccounts } from "./operator-pings.ts";
import { ROUTE_LABEL_PREFIX, ROUTE_TTL_MS } from "./routing.ts";

const HOUR_MS = 60 * 60 * 1000;

export const ROUTING_RANGES = {
  "24h": { ms: 24 * HOUR_MS, bucketMs: HOUR_MS },
  "7d": { ms: 7 * 24 * HOUR_MS, bucketMs: 6 * HOUR_MS },
} as const;
export type RoutingRange = keyof typeof ROUTING_RANGES;

/**
 * Why a relay couldn't route. `routing`: the pick walked the runner order and every step was
 * skipped; `provider` is the step's key and `reason` its skip reason (or `not_in_order` for a
 * provider the relay set that the order leaves out). `setup`: the pick stopped before the order,
 * because of how the install or repo is set up.
 */
export type UnroutableReason =
  | { kind: "routing"; provider: string; reason: string; count: number }
  | { kind: "setup"; provider: null; reason: SetupReason; count: number };

export type SetupReason =
  | "install_suspended"
  | "no_repo_access"
  | "runner_group"
  | "unreadable_job"
  | "other";

export interface RoutingBucket {
  start: string;
  /** Relays that got a runner right away. */
  routed: number;
  /** Relays that queued for a full machine's slot. */
  queued: number;
  unroutable: number;
  /** The most jobs waiting for a machine at once during the bucket. */
  peakWaiting: number;
  /** p95 of how long the bucket's machine jobs waited to start, or null when none started. */
  p95WaitMs: number | null;
}

export interface RoutingWorkspace {
  id: string;
  name: string;
  slug: string;
  relays: number;
  queued: number;
  unroutable: number;
  p95WaitMs: number | null;
  /** The most common reason its relays couldn't route, or null when none failed. */
  topReason: Omit<UnroutableReason, "count"> | null;
}

export interface RoutingHealth {
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
    /** Jobs queued on a machine's label that no runner has started. */
    waitingNow: number;
    oldestWaitingMs: number | null;
  };
  buckets: RoutingBucket[];
  /** Most common first. */
  reasons: UnroutableReason[];
  /** Workspaces with relays in the window: failures first, then the longest waits. */
  workspaces: RoutingWorkspace[];
}

/** Nearest-rank p95, or null for no values. */
export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

/** Which setup problem a relay that failed before the runner order hit, from its message. */
export function setupReason(message: string): SetupReason {
  if (/installation is suspended/i.test(message)) return "install_suspended";
  if (/doesn't have access to/i.test(message)) return "no_repo_access";
  if (/runner group/i.test(message)) return "runner_group";
  if (/couldn't read this job/i.test(message)) return "unreadable_job";
  return "other";
}

type Walk = { skipped?: { key: string; reason: string }[]; notInOrder?: string[] } | null;

/** The distinct reasons one failed relay gives, from its `job.unroutable` event data. */
export function unroutableReasons(
  data: Record<string, unknown>,
): Omit<UnroutableReason, "count">[] {
  const walk = (data.walk ?? null) as Walk;
  if (!walk) {
    const message = typeof data.reason === "string" ? data.reason : "";
    return [{ kind: "setup", provider: null, reason: setupReason(message) }];
  }
  const reasons = [
    ...(walk.skipped ?? []).map((step) => ({ provider: step.key, reason: step.reason })),
    ...(walk.notInOrder ?? []).map((key) => ({ provider: key, reason: "not_in_order" })),
  ];
  const seen = new Set<string>();
  return reasons
    .filter(({ provider, reason }) => {
      const key = `${provider}:${reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({ kind: "routing" as const, ...r }));
}

const reasonKey = (r: Omit<UnroutableReason, "count">) => `${r.kind}:${r.provider}:${r.reason}`;

/** A job on a machine's label: queued at `createdAt`, waiting until `endAt` (null: still waiting). */
interface MachineJob {
  workspaceId: string;
  createdAt: number;
  startedAt: number | null;
  endAt: number | null;
}

/** For each bucket, the most jobs waiting at once (a sweep over each job's waiting interval). */
export function peakWaiting(
  jobs: MachineJob[],
  from: number,
  bucketMs: number,
  buckets: number,
  now: number,
) {
  const peaks = Array.from({ length: buckets }, () => 0);
  const edges: [number, number][] = [];
  for (const job of jobs) {
    const end = job.endAt ?? now;
    if (end <= from || end <= job.createdAt) continue;
    edges.push([Math.max(job.createdAt, from), 1], [end, -1]);
  }
  // Ends before starts at the same instant, so back-to-back jobs don't count as overlapping.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let waiting = 0;
  let bucket = 0;
  for (const [at, change] of edges) {
    const index = Math.min(Math.floor((at - from) / bucketMs), buckets - 1);
    // A bucket entered with jobs already waiting starts at that count.
    while (bucket < index) {
      bucket += 1;
      peaks[bucket] = Math.max(peaks[bucket]!, waiting);
    }
    waiting += change;
    peaks[index] = Math.max(peaks[index]!, waiting);
  }
  while (bucket < buckets - 1) {
    bucket += 1;
    peaks[bucket] = Math.max(peaks[bucket]!, waiting);
  }
  return peaks;
}

export async function routingHealth(
  db: Db,
  range: RoutingRange,
  options: { now?: Date; ignoredGithubIds?: number[] } = {},
): Promise<RoutingHealth> {
  const now = (options.now ?? new Date()).getTime();
  const { ms, bucketMs } = ROUTING_RANGES[range];
  // Buckets end on the hour, the last one holding now.
  const to = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const from = to - ms;
  const bucketCount = ms / bucketMs;
  const bucketOf = (at: number) => Math.floor((at - from) / bucketMs);

  const decision = schema.routeDecision;
  const event = schema.activityEvent;
  const job = schema.workflowJob;
  const [workspaces, internal, tests, decisions, failures, jobs] = await Promise.all([
    db
      .select({
        id: schema.workspace.id,
        name: schema.workspace.name,
        slug: schema.workspace.slug,
        installationId: schema.workspace.installationId,
      })
      .from(schema.workspace),
    internalWorkspaceIds(db),
    testAccounts(db, options.ignoredGithubIds ?? []),
    db
      .select({
        workspaceId: decision.workspaceId,
        step: decision.step,
        waitedAt: decision.waitedAt,
        createdAt: decision.createdAt,
      })
      .from(decision)
      .where(gte(decision.createdAt, new Date(from))),
    db
      .select({ workspaceId: event.workspaceId, data: event.data, occurredAt: event.occurredAt })
      .from(event)
      .where(and(eq(event.type, "job.unroutable"), gte(event.occurredAt, new Date(from)))),
    // Jobs queued up to a route's lifetime before the window can still be waiting in it.
    db
      .select({
        installationId: job.installationId,
        labels: job.labels,
        status: job.status,
        createdAt: job.githubCreatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      })
      .from(job)
      .where(and(eq(job.kind, "job"), gte(job.githubCreatedAt, new Date(from - ROUTE_TTL_MS)))),
  ]);

  const counted = (id: string) => !internal.has(id) && !tests.workspaces.has(id);
  const byInstallation = new Map(workspaces.map((w) => [w.installationId, w.id]));

  const buckets: RoutingBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: new Date(from + i * bucketMs).toISOString(),
    routed: 0,
    queued: 0,
    unroutable: 0,
    peakWaiting: 0,
    p95WaitMs: null,
  }));
  type Tally = {
    relays: number;
    queued: number;
    unroutable: number;
    waits: number[];
    reasons: Map<string, number>;
  };
  const tallies = new Map<string, Tally>();
  const tally = (id: string) => {
    let t = tallies.get(id);
    if (!t)
      tallies.set(id, (t = { relays: 0, queued: 0, unroutable: 0, waits: [], reasons: new Map() }));
    return t;
  };

  let routed = 0;
  let queued = 0;
  for (const row of decisions) {
    // A relay that couldn't route is counted from its event, which setup failures have too.
    if (row.step === null || !counted(row.workspaceId)) continue;
    const bucket = buckets[bucketOf(row.createdAt.getTime())];
    const t = tally(row.workspaceId);
    t.relays += 1;
    if (row.waitedAt) {
      queued += 1;
      t.queued += 1;
      if (bucket) bucket.queued += 1;
    } else {
      routed += 1;
      if (bucket) bucket.routed += 1;
    }
  }

  const reasonCounts = new Map<string, UnroutableReason>();
  const failedWorkspaces = new Set<string>();
  let unroutable = 0;
  for (const row of failures) {
    if (!counted(row.workspaceId)) continue;
    unroutable += 1;
    failedWorkspaces.add(row.workspaceId);
    const bucket = buckets[bucketOf(row.occurredAt.getTime())];
    if (bucket) bucket.unroutable += 1;
    const t = tally(row.workspaceId);
    t.relays += 1;
    t.unroutable += 1;
    for (const reason of unroutableReasons(row.data)) {
      const key = reasonKey(reason);
      const known = reasonCounts.get(key);
      if (known) known.count += 1;
      else reasonCounts.set(key, { ...reason, count: 1 } as UnroutableReason);
      t.reasons.set(key, (t.reasons.get(key) ?? 0) + 1);
    }
  }

  const machineJobs: MachineJob[] = [];
  for (const row of jobs) {
    const workspaceId = byInstallation.get(row.installationId);
    if (!workspaceId || !counted(workspaceId)) continue;
    if (!row.labels.some((label) => label.startsWith(ROUTE_LABEL_PREFIX))) continue;
    const createdAt = row.createdAt.getTime();
    const startedAt = row.startedAt?.getTime() ?? null;
    // A job cancelled before any runner took it stops waiting when it completes.
    const endAt =
      startedAt ?? row.completedAt?.getTime() ?? (row.status === "completed" ? createdAt : null);
    machineJobs.push({ workspaceId, createdAt, startedAt, endAt });
  }
  const waitsByBucket = Array.from({ length: bucketCount }, () => [] as number[]);
  const allWaits: number[] = [];
  let waitingNow = 0;
  let oldestWaiting: number | null = null;
  for (const j of machineJobs) {
    if (j.endAt === null && now - j.createdAt <= ROUTE_TTL_MS) {
      waitingNow += 1;
      oldestWaiting = Math.min(oldestWaiting ?? Infinity, j.createdAt);
    }
    if (j.startedAt === null || j.createdAt < from) continue;
    const wait = Math.max(0, j.startedAt - j.createdAt);
    allWaits.push(wait);
    waitsByBucket[bucketOf(j.createdAt)]?.push(wait);
    tally(j.workspaceId).waits.push(wait);
  }
  const peaks = peakWaiting(
    machineJobs.filter((j) => j.endAt !== null || now - j.createdAt <= ROUTE_TTL_MS),
    from,
    bucketMs,
    bucketCount,
    now,
  );
  buckets.forEach((bucket, i) => {
    // A bucket still to come in this hour has nothing waiting yet.
    bucket.peakWaiting = from + i * bucketMs > now ? 0 : peaks[i]!;
    bucket.p95WaitMs = p95(waitsByBucket[i]!);
  });

  const names = new Map(workspaces.map((w) => [w.id, w]));
  const rows: RoutingWorkspace[] = [];
  for (const [id, t] of tallies) {
    const workspace = names.get(id);
    if (!workspace || t.relays === 0) continue;
    const [top] = [...t.reasons].sort((a, b) => b[1] - a[1]);
    const topReason = top ? reasonCounts.get(top[0]) : undefined;
    rows.push({
      id,
      name: workspace.name,
      slug: workspace.slug,
      relays: t.relays,
      queued: t.queued,
      unroutable: t.unroutable,
      p95WaitMs: p95(t.waits),
      topReason: topReason
        ? ({
            kind: topReason.kind,
            provider: topReason.provider,
            reason: topReason.reason,
          } as RoutingWorkspace["topReason"])
        : null,
    });
  }
  rows.sort(
    (a, b) =>
      b.unroutable - a.unroutable ||
      (b.p95WaitMs ?? -1) - (a.p95WaitMs ?? -1) ||
      b.relays - a.relays,
  );

  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketMs,
    totals: {
      relays: routed + queued + unroutable,
      routed,
      queued,
      unroutable,
      unroutableWorkspaces: failedWorkspaces.size,
      p95WaitMs: p95(allWaits),
      waitingNow,
      oldestWaitingMs: oldestWaiting === null ? null : now - oldestWaiting,
    },
    buckets,
    reasons: [...reasonCounts.values()].sort((a, b) => b.count - a.count),
    workspaces: rows,
  };
}
