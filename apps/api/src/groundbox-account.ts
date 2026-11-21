// Groundbox's account, for the Router's Groundbox step. Groundbox's Free plan includes 3,000 free
// minutes a month and $5 of credit, and holds jobs once both run out; any plan holds jobs at the
// spend caps set in Groundbox's dashboard, or while Groundbox holds or suspends the account. A held
// job waits on Groundbox, so the step passes it on instead, and a step with a minutes limit
// (`limit.percent`) passes jobs on once that share of the free minutes is used.
//
// Everything comes from Groundbox's own `GET /v1/account`, read with the workspace's Groundbox
// connection (Settings › Providers) right before the step takes a job, and reused for a minute.
// Without a connection, with a key Groundbox refuses, or when the read fails, the step takes the
// job as it always has: a missing number shouldn't stall CI.
import type { ProviderHeld } from "@relayrunner/activity";
import { FREE_MINUTES } from "@relayrunner/runner-order";
import { and, eq } from "drizzle-orm";
import { cycleStart } from "./actions-billing.ts";
import { type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { errorMessage } from "./errors.ts";
import type { MinutesUsage } from "./minutes-rule.ts";
import { type GroundboxAccount, groundboxAccount } from "./provider-billing/groundbox.ts";
import { ProviderAuthError } from "./provider-billing/index.ts";
import { openToken } from "./provider-tokens.ts";

/** How long a reading is reused. Free minutes only move as jobs finish, so a minute is close enough. */
export const ACCOUNT_TTL_MS = 60_000;

/** Why a workspace's Groundbox account can't be read. */
export type GroundboxReadFailure = "not_connected" | "token_rejected" | "read_failed";

export type GroundboxReading =
  | { ok: true; account: GroundboxAccount; readAt: number }
  | { ok: false; reason: GroundboxReadFailure };

/** Read the workspace's Groundbox account with its connection. Never throws. */
export async function readGroundboxAccount(
  env: Pick<Env, "PROVIDER_TOKEN_KEY">,
  db: Db,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<GroundboxReading> {
  const connections = schema.providerConnection;
  const key = and(eq(connections.workspaceId, workspaceId), eq(connections.provider, "groundbox"));
  const [connection] = await db
    .select({ token: connections.token, failure: connections.failure })
    .from(connections)
    .where(key)
    .limit(1);
  if (!connection) return { ok: false, reason: "not_connected" };
  // A refused key stays refused until someone pastes a new one, which clears the failure.
  if (connection.failure === "token_rejected") return { ok: false, reason: "token_rejected" };
  try {
    const token = await openToken(env, workspaceId, "groundbox", connection.token);
    const account = await groundboxAccount({ token, options: {}, fetch: fetcher });
    return { ok: true, account, readAt: now.getTime() };
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "groundbox account unreadable",
        workspaceId,
        error: errorMessage(error),
      }),
    );
    if (error instanceof ProviderAuthError) {
      // Settings › Providers then says the key stopped working.
      await db
        .update(connections)
        .set({
          failure: "token_rejected",
          error: errorMessage(error).slice(0, 500),
          failedAt: now,
        })
        .where(key);
      return { ok: false, reason: "token_rejected" };
    }
    return { ok: false, reason: "read_failed" };
  }
}

/** The free minutes as a minutes limit reads them, or null when Groundbox didn't say. */
export function groundboxMinutes(reading: GroundboxReading | null): MinutesUsage | null {
  if (!reading?.ok || !reading.account.freeMinutes) return null;
  const { team, freeMinutes } = reading.account;
  return {
    status: "ok",
    accountLogin: team ?? "",
    quotaMinutes: freeMinutes.included,
    usedMinutes: freeMinutes.used,
    // A live reading: no billing lag to leave runway for.
    burnRatePerHour: null,
  };
}

/** Why Groundbox would hold a job now, or null when it would run it (or can't be read). */
export function groundboxHeld(reading: GroundboxReading | null): ProviderHeld | null {
  if (!reading?.ok) return null;
  const { status, caps, plan, freeMinutes, balanceUsd } = reading.account;
  if (status === "suspended") return { reason: "account_suspended" };
  if (status === "held") return { reason: "account_held" };
  if (
    caps &&
    ((caps.dailyUsd !== null && caps.spentTodayUsd >= caps.dailyUsd) ||
      (caps.monthlyUsd !== null && caps.spentThisMonthUsd >= caps.monthlyUsd))
  )
    return { reason: "spend_cap" };
  // Free holds jobs once the free minutes and the credit are both gone.
  if (
    plan === "free" &&
    freeMinutes &&
    freeMinutes.left <= 0 &&
    balanceUsd !== null &&
    balanceUsd <= 0
  )
    return { reason: "out_of_credit" };
  return null;
}

/** The dashboard's view: the free minutes in the same shape as Blacksmith's, and any hold. */
export interface GroundboxMinutesView {
  status: "ok" | "not_available";
  reason: GroundboxReadFailure | "no_free_minutes" | null;
  accountLogin: string;
  quotaMinutes: number;
  usedMinutes: number;
  burnRatePerHour: null;
  cycleStart: string;
  syncedAt: string | null;
  held: ProviderHeld["reason"] | null;
  ciSpentUsd: number | null;
  // The team's Groundbox plan (free, monthly, annual, sponsored) and its credit left in dollars,
  // so a team without free minutes can be told which plan it's on and what pays for its jobs.
  plan: string | null;
  balanceUsd: number | null;
}

export function groundboxMinutesView(
  reading: GroundboxReading,
  now = Date.now(),
): GroundboxMinutesView {
  const base = {
    accountLogin: "",
    quotaMinutes: FREE_MINUTES.groundbox,
    usedMinutes: 0,
    burnRatePerHour: null,
    cycleStart: cycleStart(new Date(now)).toISOString(),
    syncedAt: null,
    held: null,
    ciSpentUsd: null,
    plan: null,
    balanceUsd: null,
  };
  if (!reading.ok) return { ...base, status: "not_available", reason: reading.reason };
  const { account } = reading;
  const view = {
    ...base,
    accountLogin: account.team ?? "",
    syncedAt: new Date(reading.readAt).toISOString(),
    held: groundboxHeld(reading)?.reason ?? null,
    ciSpentUsd: account.ciSpentUsd,
    plan: account.plan,
    balanceUsd: account.balanceUsd,
  };
  const free = account.freeMinutes;
  if (!free) return { ...view, status: "not_available", reason: "no_free_minutes" };
  return {
    ...view,
    status: "ok",
    reason: null,
    quotaMinutes: free.included,
    usedMinutes: free.used,
    cycleStart: free.periodStart ?? view.cycleStart,
  };
}
