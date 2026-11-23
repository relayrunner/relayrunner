// A provider's free minutes for the dev preview (lib/sample/answers.ts), like GET
// /api/providers/:provider/minutes.
import { FREE_MINUTES, type FreeMinutesProvider } from "@relayrunner/runner-order";
import type { FreeMinutes } from "../free-minutes.ts";

/** Dev-preview data: `connected` a workspace partway through its free minutes. */
export function sampleFreeMinutes(provider: FreeMinutesProvider, connected: boolean): FreeMinutes {
  const now = new Date();
  return {
    status: connected ? "ok" : "not_available",
    reason: connected ? null : "not_connected",
    accountLogin: connected ? "acme" : "",
    quotaMinutes: FREE_MINUTES[provider],
    usedMinutes: connected ? (provider === "blacksmith" ? 2140 : 1260) : 0,
    burnRatePerHour: connected && provider === "blacksmith" ? 24 : null,
    cycleStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    syncedAt: connected ? new Date(now.getTime() - 20 * 60_000).toISOString() : null,
    ...(provider === "groundbox" ? { held: null, ciSpentUsd: connected ? 0 : null } : {}),
  };
}
