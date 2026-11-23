// Admin › Routing health for the dev preview (lib/sample/answers.ts), like GET /api/admin/routing.
import { zoneParts } from "../time-zone";
import type { RoutingBucket, RoutingHealth, RoutingRange } from "../admin-routing.ts";

/** Made-up data for the dev server without sign-in (VITE_AUTH_DISABLED). */
export function sampleRoutingHealth(range: RoutingRange): RoutingHealth {
  const bucketMs = range === "24h" ? 3_600_000 : 6 * 3_600_000;
  const count = range === "24h" ? 24 : 28;
  const to = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const from = to - count * bucketMs;
  const noise = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  const buckets: RoutingBucket[] = Array.from({ length: count }, (_, i) => {
    const { hour } = zoneParts(from + i * bucketMs);
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
