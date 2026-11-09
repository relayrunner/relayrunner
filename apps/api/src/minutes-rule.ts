// The GitHub step's minutes limit (#117): while a step has `limit`, it takes a job only while the
// job's own GitHub account (its installation) has room left in its included Actions quota. Usage
// comes from the billing poll (#116, src/actions-billing.ts) and is judged per account, never
// pooled across the workspace.
//
// Billing lags GitHub by up to ~90 minutes and the poll adds up to 15 more, so the step also stops
// once fewer minutes are left than the account burns in RUNWAY_HOURS: jobs started during the lag
// still fit under the quota.
import type { AccountUsage } from "./actions-billing.ts";

export const RUNWAY_HOURS = 2;

/** Why a limited GitHub step passed a job on, with the numbers the Activity page shows. */
export interface MinutesSkip {
  // minutes_limit: used is at or past `percent` of the quota.
  // minutes_runway: under the limit, but fewer quota minutes are left than RUNWAY_HOURS of
  // recent burn.
  reason: "minutes_limit" | "minutes_runway";
  account: string;
  usedMinutes: number;
  quotaMinutes: number;
  percent: number;
  burnRatePerHour: number | null;
}

/**
 * Null when the step may take the job, or why it can't. An account whose usage isn't available
 * (no quota, not read yet, a read error) never blocks: a missing number shouldn't stall CI.
 */
export function minutesCheck(usage: AccountUsage | null, percent: number): MinutesSkip | null {
  if (!usage || usage.status !== "ok" || !usage.quotaMinutes) return null;
  const { usedMinutes, quotaMinutes, burnRatePerHour, accountLogin } = usage;
  const skip = { account: accountLogin, usedMinutes, quotaMinutes, percent, burnRatePerHour };
  const limit = (quotaMinutes * percent) / 100;
  if (usedMinutes >= limit) return { reason: "minutes_limit", ...skip };
  if (burnRatePerHour && quotaMinutes - usedMinutes < burnRatePerHour * RUNWAY_HOURS)
    return { reason: "minutes_runway", ...skip };
  return null;
}
