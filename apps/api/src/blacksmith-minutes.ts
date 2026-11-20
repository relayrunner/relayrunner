// Blacksmith's free minutes, for the Blacksmith step's minutes limit: like the GitHub step's (#117,
// src/minutes-rule.ts), a step with `limit` takes a job only while the workspace has room left in
// Blacksmith's free minutes this month. The count comes from the workspace's Blacksmith
// connection (Settings › Providers), which syncs `blacksmith usage` hourly (src/provider-sync.ts),
// so without one, or before its first sync, the step never blocks: a missing number shouldn't
// stall CI.
//
// Blacksmith counts its free minutes in 2-vCPU minutes, and bills minutes times vCPUs, so a month's
// billable minutes over two are the free minutes it used. Blacksmith's own month is the UTC
// calendar month, the same one the GitHub limit counts.
import { BLACKSMITH_FREE_MINUTES } from "@relayrunner/runner-order";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { cycleStart } from "./actions-billing.ts";
import { type Db, schema } from "./db/index.ts";
import type { MinutesUsage } from "./minutes-rule.ts";

/** The vCPUs one free minute covers: a 4-vCPU job's minute uses two. */
export const VCPUS_PER_FREE_MINUTE = 2;

// Burn is read over the synced jobs of the last few hours before the last sync.
const BURN_WINDOW_MS = 6 * 60 * 60_000;

/** Why a workspace's Blacksmith minutes can't be counted. */
export type BlacksmithMinutesReason =
  | "not_connected"
  | "not_synced"
  | "token_rejected"
  | "sync_failed";

export interface BlacksmithMinutes extends MinutesUsage {
  reason: BlacksmithMinutesReason | null;
  // The month the count is for (UTC midnight, ISO), and when the last sync finished.
  cycleStart: string;
  syncedAt: string | null;
}

/** The workspace's Blacksmith free minutes this month, as far as its connection has synced. */
export async function blacksmithMinutes(
  db: Db,
  workspaceId: string,
  now = Date.now(),
): Promise<BlacksmithMinutes> {
  const month = cycleStart(new Date(now));
  const connections = schema.providerConnection;
  const [connection] = await db
    .select({
      options: connections.options,
      accountName: connections.accountName,
      lastSyncedAt: connections.lastSyncedAt,
      failure: connections.failure,
    })
    .from(connections)
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.provider, "blacksmith")))
    .limit(1);
  const base = {
    accountLogin: connection?.options.organization ?? connection?.accountName ?? "",
    quotaMinutes: BLACKSMITH_FREE_MINUTES,
    usedMinutes: 0,
    burnRatePerHour: null,
    cycleStart: month.toISOString(),
    syncedAt: connection?.lastSyncedAt?.toISOString() ?? null,
  };
  if (!connection) return { ...base, status: "not_available", reason: "not_connected" };
  if (connection.failure === "token_rejected")
    return { ...base, status: "not_available", reason: "token_rejected" };
  if (!connection.lastSyncedAt) return { ...base, status: "not_available", reason: "not_synced" };

  const days = schema.providerDailyUsage;
  const jobs = schema.providerJobUsage;
  const syncedAt = connection.lastSyncedAt.getTime();
  const [[billed], [recent]] = await Promise.all([
    db
      .select({ minutes: sql<number>`coalesce(sum(${days.quantity}), 0)` })
      .from(days)
      .where(
        and(
          eq(days.workspaceId, workspaceId),
          eq(days.provider, "blacksmith"),
          eq(days.unit, "billable_minutes"),
          gte(days.day, month),
        ),
      ),
    db
      .select({ seconds: sql<number>`coalesce(sum(${jobs.billableSeconds}), 0)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.provider, "blacksmith"),
          gte(jobs.finishedAt, new Date(Math.max(syncedAt - BURN_WINDOW_MS, month.getTime()))),
          lte(jobs.finishedAt, new Date(syncedAt)),
        ),
      ),
  ]);
  const hours = Math.min(BURN_WINDOW_MS, syncedAt - month.getTime()) / 3_600_000;
  const burned = (recent?.seconds ?? 0) / 60 / VCPUS_PER_FREE_MINUTE;
  return {
    ...base,
    // A sync that failed for another reason keeps the count it last read: still the best there
    // is, and it only falls behind, never ahead. The dashboard says it's behind.
    status: "ok",
    reason: connection.failure ? "sync_failed" : null,
    usedMinutes: (billed?.minutes ?? 0) / VCPUS_PER_FREE_MINUTE,
    burnRatePerHour: hours > 0 && burned > 0 ? burned / hours : null,
  };
}
