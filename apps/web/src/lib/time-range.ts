// A report's time range, as one string that goes in the URL as it is: a rolling preset such as
// `24h` or `14d`, a calendar one such as `today`, `week` or `month`, or a custom range of local dates,
// `2026-11-01..2026-11-07` (both days included).

// Days are the dashboard's time zone's (time-zone.ts). Kept free of `@/` imports so tests can load
// it, like runner-days.ts.
import { parseDateText, shortDate, startOfDay, startOfMonth, startOfWeek } from "./time-zone.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const ROLLING = ["1h", "3h", "24h", "2d", "7d", "14d", "30d", "90d"] as const;
export const CALENDAR = ["today", "yesterday", "week", "lastweek", "month", "lastmonth"] as const;

export type RollingRange = (typeof ROLLING)[number];
export type CalendarRange = (typeof CALENDAR)[number];
export type RangePreset = RollingRange | CalendarRange;
export type CustomRange = `${string}..${string}`;
export type TimeRange = RangePreset | CustomRange;

const NAMES: Record<RangePreset, string> = {
  "1h": "Past hour",
  "3h": "Past 3 hours",
  "24h": "Past 24 hours",
  "2d": "Past 2 days",
  "7d": "Past 7 days",
  "14d": "Past 14 days",
  "30d": "Past 30 days",
  "90d": "Past 90 days",
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  lastweek: "Last week",
  month: "This month",
  lastmonth: "Last month",
};

/** A rolling preset's length. */
function rollingMs(range: RollingRange) {
  const amount = Number.parseInt(range, 10);
  return amount * (range.endsWith("h") ? HOUR_MS : DAY_MS);
}

const isRolling = (value: unknown): value is RollingRange =>
  (ROLLING as readonly unknown[]).includes(value);

export const isCalendar = (value: unknown): value is CalendarRange =>
  (CALENDAR as readonly unknown[]).includes(value);

export const isCustom = (range: TimeRange): range is CustomRange => range.includes("..");

/** The rolling preset for a range of `days` days, as the older `?days=` params counted them. */
export const dayPreset = (days: number) => (days === 1 ? "24h" : `${days}d`) as RollingRange;

/** How many whole days a rolling preset spans, at least one. */
export const presetDays = (range: RollingRange) =>
  Math.max(1, Math.round(rollingMs(range) / DAY_MS));

/** A custom range's two days as local midnights, or null when it isn't two valid days in order. */
function parseCustom(range: string) {
  const [from = "", to = "", extra] = range.split("..");
  const start = parseDateText(from);
  const end = parseDateText(to);
  return extra === undefined && start <= end ? { start, end } : null;
}

/** The earliest day a custom range may start, `customDays` back. */
export const customRangeStart = (customDays: number, now = Date.now()) =>
  startOfDay(now, -customDays);

/** A custom range from two local days, in order, both included. */
export function customRange(from: string, to: string): CustomRange {
  return parseDateText(from) <= parseDateText(to) ? `${from}..${to}` : `${to}..${from}`;
}

/** Where a range starts and ends, in epoch ms, as of `now`. */
export function resolveRange(range: TimeRange, now = Date.now()): { from: number; to: number } {
  if (isRolling(range)) return { from: now - rollingMs(range), to: now };
  switch (range) {
    case "today":
      return { from: startOfDay(now), to: now };
    case "yesterday":
      return { from: startOfDay(now, -1), to: startOfDay(now) };
    case "week":
      return { from: startOfWeek(now), to: now };
    case "lastweek": {
      const week = startOfWeek(now);
      return { from: startOfDay(week, -7), to: week };
    }
    case "month":
      return { from: startOfMonth(now), to: now };
    case "lastmonth":
      return { from: startOfMonth(now, -1), to: startOfMonth(now) };
  }
  const { start, end } = parseCustom(range) ?? { start: Number.NaN, end: Number.NaN };
  // A custom range ends at the end of its last day, or now if that's today.
  return { from: start, to: Math.min(now, startOfDay(end, 1)) };
}

/** The range as a report's query, `from=…&to=…` in epoch ms, so the API reads the same days. */
export function rangeQuery(range: TimeRange, now = Date.now()) {
  const { from, to } = resolveRange(range, now);
  return `from=${from}&to=${to}`;
}

/** How many days a range spans, at least one. */
export function rangeDays(range: TimeRange, now = Date.now()) {
  const { from, to } = resolveRange(range, now);
  return Math.max(1, Math.round((to - from) / DAY_MS));
}

/** A short code for how long a range spans, such as `3h`, `19h` or `6d`. */
export function spanCode(range: TimeRange, now = Date.now()) {
  if (isRolling(range)) return range;
  const { from, to } = resolveRange(range, now);
  const span = to - from;
  if (span < HOUR_MS) return `${Math.max(1, Math.round(span / 60_000))}m`;
  if (span < 2 * DAY_MS) return `${Math.round(span / HOUR_MS)}h`;
  return `${Math.round(span / DAY_MS)}d`;
}

/** The range's name, such as "Past 24 hours", "This week" or "Nov 1 – Nov 7". */
export function rangeName(range: TimeRange) {
  if (!isCustom(range)) return NAMES[range];
  const { start, end } = parseCustom(range) ?? { start: Number.NaN, end: Number.NaN };
  return start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`;
}

/** The range as the end of a sentence: "the past 24 hours", "this week", "Nov 1 – Nov 7". */
export function rangePhrase(range: TimeRange) {
  if (isCustom(range)) return rangeName(range);
  const name = NAMES[range].toLowerCase();
  return isRolling(range) ? `the ${name}` : name;
}

export type RangeOptions = {
  /** The presets the page offers, in the order it lists them. */
  presets: readonly RangePreset[];
  /** Whether it takes a custom range, and how many days back one may reach. */
  customDays?: number;
};

/** A range from the URL when it's one the page offers, other than `fallback`. */
export function timeRangeParam(
  value: unknown,
  { presets, customDays }: RangeOptions,
  fallback: TimeRange,
  now = Date.now(),
): TimeRange | undefined {
  if (typeof value !== "string" || value === fallback) return undefined;
  if ((presets as readonly string[]).includes(value)) return value as RangePreset;
  if (!customDays) return undefined;
  const custom = parseCustom(value);
  return custom && custom.start >= customRangeStart(customDays, now) && custom.end <= now
    ? (value as CustomRange)
    : undefined;
}

/**
 * `?range=` when it's one the page offers other than its default. An older link's `?days=7` reads
 * as `7d`.
 */
export function reportRangeParam(
  search: Record<string, unknown>,
  options: RangeOptions,
  fallback: TimeRange,
) {
  const value = search.range ?? (search.days ? dayPreset(Number(search.days)) : undefined);
  return timeRangeParam(value, options, fallback);
}
