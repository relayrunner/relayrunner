import { BLACKSMITH_FREE_MINUTES } from "@relayrunner/runner-order";
import { api } from "./api";

// The workspace's free Blacksmith minutes this month (GET /api/providers/blacksmith/minutes),
// counted from its Blacksmith connection in Settings › Providers. The Router's Blacksmith step
// can stop at a share of them. The shape mirrors BlacksmithMinutes in
// apps/api/src/blacksmith-minutes.ts.

export type BlacksmithMinutesReason =
  | "not_connected"
  | "not_synced"
  | "token_rejected"
  | "sync_failed";

export interface BlacksmithMinutes {
  status: "ok" | "not_available";
  reason: BlacksmithMinutesReason | null;
  // The Blacksmith organization.
  accountLogin: string;
  quotaMinutes: number;
  // In 2-vCPU minutes, the way Blacksmith counts its free minutes.
  usedMinutes: number;
  burnRatePerHour: number | null;
  cycleStart: string;
  syncedAt: string | null;
}

export function getBlacksmithMinutes() {
  return api<BlacksmithMinutes>("/providers/blacksmith/minutes");
}

/** Whether the count is there to stop at: connected, and synced at least once. */
export const counted = (minutes: BlacksmithMinutes | null): minutes is BlacksmithMinutes =>
  minutes?.status === "ok";

/** Dev-preview data: `connected` a workspace partway through its free minutes. */
export function sampleBlacksmithMinutes(connected: boolean): BlacksmithMinutes {
  const now = new Date();
  return {
    status: connected ? "ok" : "not_available",
    reason: connected ? null : "not_connected",
    accountLogin: connected ? "acme" : "",
    quotaMinutes: BLACKSMITH_FREE_MINUTES,
    usedMinutes: connected ? 2140 : 0,
    burnRatePerHour: connected ? 24 : null,
    cycleStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    syncedAt: connected ? new Date(now.getTime() - 20 * 60_000).toISOString() : null,
  };
}
