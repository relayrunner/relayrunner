// Where a GitHub account's included Actions minutes are headed this billing cycle (a UTC calendar
// month): the day they run out at the current pace, or how many will go unused by the reset.
//
// The pace comes from the cycle's last two weeks of daily usage, not the whole cycle, so a busy
// stretch or a quiet one shows up within days. CI runs mostly on weekdays, so when there are enough
// of both, weekdays and weekend days get their own rates: a Friday reading doesn't count Saturday
// as a working day.
//
// `outlook` is what the dashboard says, and later what routing can act on: "surplus" means minutes
// already paid for will go unused, so GitHub-hosted runners could take more jobs this cycle.

const DAY_MS = 86_400_000;

// The pace looks back over this many complete days at most.
export const PACE_WINDOW_DAYS = 14;
// Weekdays and weekend days get separate rates only with at least this many of each in the window.
const MIN_WEEKDAYS = 3;
const MIN_WEEKEND_DAYS = 1;
// Unused minutes at the reset above this share of the quota count as a surplus.
export const SURPLUS_SHARE = 0.25;

export type MinutesOutlook =
  // The included minutes run out before the reset; GitHub bills jobs after that.
  | "runs_out"
  // Already past the included minutes this cycle.
  | "over"
  // At least SURPLUS_SHARE of the minutes will go unused.
  | "surplus"
  // Most of the minutes get used, and they last.
  | "on_track";

export interface MinutesProjection {
  outlook: MinutesOutlook;
  // Quota minutes a day at the current pace (weekday and weekend averaged over a week).
  minutesPerDay: number;
  // Quota minutes used by the reset at this pace.
  projectedMinutes: number;
  // When the included minutes run out, for "runs_out". Null otherwise.
  runsOutAt: string | null;
  // When the cycle resets: the first of next month, UTC.
  resetsAt: string;
}

/** One UTC day's quota minutes. `day` is YYYY-MM-DD. */
export interface DayUsage {
  day: string;
  usedMinutes: number;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isWeekend = (ms: number) => {
  const weekday = new Date(ms).getUTCDay();
  return weekday === 0 || weekday === 6;
};
const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Minutes a day for weekdays and weekend days from the cycle's recent complete days. Without daily
 * figures (an older poll), the cycle's average so far stands in for both.
 */
function dailyRates(
  days: DayUsage[],
  usedMinutes: number,
  start: number,
  today: number,
  now: number,
) {
  if (days.length === 0) {
    const flat = (usedMinutes / (now - start)) * DAY_MS;
    return { weekday: flat, weekend: flat };
  }
  const byDay = new Map(days.map((d) => [d.day, d.usedMinutes]));
  const weekdays: number[] = [];
  const weekend: number[] = [];
  for (let ms = Math.max(start, today - PACE_WINDOW_DAYS * DAY_MS); ms < today; ms += DAY_MS)
    (isWeekend(ms) ? weekend : weekdays).push(byDay.get(dayKey(ms)) ?? 0);
  if (weekdays.length >= MIN_WEEKDAYS && weekend.length >= MIN_WEEKEND_DAYS)
    return { weekday: average(weekdays), weekend: average(weekend) };
  const flat = average([...weekdays, ...weekend]);
  return { weekday: flat, weekend: flat };
}

/**
 * Where the cycle that started at `cycleStart` is headed. `days` are its daily quota minutes so far
 * (any order, gaps are days without usage); `usedMinutes` is the cycle's total, which also counts
 * today. Null without a quota or before a full day of the cycle has passed.
 */
export function projectMinutes({
  days,
  usedMinutes,
  quotaMinutes,
  cycleStart,
  now,
}: {
  days: DayUsage[];
  usedMinutes: number;
  quotaMinutes: number | null;
  cycleStart: Date;
  now: Date;
}): MinutesProjection | null {
  if (!quotaMinutes) return null;
  const start = cycleStart.getTime();
  const end = Date.UTC(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth() + 1, 1);
  const at = now.getTime();
  const today = at - (at % DAY_MS);
  if (today <= start || at >= end) return null;

  const rates = dailyRates(days, usedMinutes, start, today, at);
  const rateOn = (ms: number) => (isWeekend(ms) ? rates.weekend : rates.weekday);

  // Walk forward from now, the rest of today first, then whole days until the reset.
  let total = usedMinutes;
  let runsOutAt: number | null = null;
  for (let from = at; from < end;) {
    const until = Math.min(end, from - (from % DAY_MS) + DAY_MS);
    const perMs = rateOn(from) / DAY_MS;
    const added = perMs * (until - from);
    // Landing on the quota right at the reset still counts as lasting.
    if (runsOutAt === null && total < quotaMinutes && total + added >= quotaMinutes) {
      const at = from + (quotaMinutes - total) / perMs;
      if (at < end) runsOutAt = at;
    }
    total += added;
    from = until;
  }

  const outlook: MinutesOutlook =
    usedMinutes >= quotaMinutes
      ? "over"
      : runsOutAt !== null
        ? "runs_out"
        : quotaMinutes - total >= quotaMinutes * SURPLUS_SHARE
          ? "surplus"
          : "on_track";
  return {
    outlook,
    minutesPerDay: round((rates.weekday * 5 + rates.weekend * 2) / 7),
    projectedMinutes: round(total),
    runsOutAt: runsOutAt === null ? null : new Date(runsOutAt).toISOString(),
    resetsAt: new Date(end).toISOString(),
  };
}
