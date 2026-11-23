import type { HeldReason } from "@relayrunner/activity";
import {
  FREE_MINUTES,
  FREE_MINUTES_PROVIDERS,
  type FreeMinutesProvider,
} from "@relayrunner/runner-order";
import { api } from "./api";

// A hosted provider's free minutes this month (GET /api/providers/<provider>/minutes), counted
// from the workspace's connection in Settings › Providers: Blacksmith's from its hourly usage
// sync, Groundbox's read live from its account. The Router's step for that provider can stop at a
// share of them. The shape mirrors BlacksmithMinutes (apps/api/src/providers/blacksmith-minutes.ts) and
// GroundboxMinutesView (apps/api/src/providers/groundbox-account.ts).

export type FreeMinutesReason =
  | "not_connected"
  | "not_synced"
  | "token_rejected"
  | "sync_failed"
  // Groundbox only: its account couldn't be read just now, or its plan has no free minutes.
  | "read_failed"
  | "no_free_minutes";

export interface FreeMinutes {
  status: "ok" | "not_available";
  reason: FreeMinutesReason | null;
  // The provider's organization or team.
  accountLogin: string;
  quotaMinutes: number;
  // Blacksmith's are 2-vCPU minutes, the way it counts its free minutes.
  usedMinutes: number;
  burnRatePerHour: number | null;
  cycleStart: string;
  // When the count was synced, or for Groundbox read.
  syncedAt: string | null;
  // Groundbox only: why it would hold jobs now, and its CI spend this month in dollars.
  held?: HeldReason | null;
  ciSpentUsd?: number | null;
  // Groundbox only: the team's plan (free, monthly, annual, sponsored) and its credit left in
  // dollars. A plan without free minutes (reason no_free_minutes) is named in the Router.
  plan?: string | null;
  balanceUsd?: number | null;
}

/** Whether the provider says its plan has no free minutes, so a minutes limit has nothing to count. */
export const noFreeMinutes = (minutes: FreeMinutes | null | undefined) =>
  minutes?.reason === "no_free_minutes";

/** Each free-minutes provider's count, null where it couldn't be read. */
export type FreeMinutesByProvider = Partial<Record<FreeMinutesProvider, FreeMinutes | null>>;

export function getFreeMinutes(provider: FreeMinutesProvider) {
  return api<FreeMinutes>(`/providers/${provider}/minutes`);
}

/** Every provider's count, each null when its read fails, so a page loads without them. */
export async function getAllFreeMinutes(): Promise<FreeMinutesByProvider> {
  const counts = await Promise.all(
    FREE_MINUTES_PROVIDERS.map((provider) => getFreeMinutes(provider).catch(() => null)),
  );
  return Object.fromEntries(FREE_MINUTES_PROVIDERS.map((p, i) => [p, counts[i]]));
}

/** Whether the count is there to stop at: connected, and synced or read. */
export const counted = (minutes: FreeMinutes | null | undefined): minutes is FreeMinutes =>
  minutes?.status === "ok";

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
