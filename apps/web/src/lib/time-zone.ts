// The time zone the dashboard shows times and days in: the one the person picked in Settings ›
// Profile, else the browser's. Every date the dashboard prints, every "today" and every day
// or hour a chart buckets by goes through here, so they all agree.

// Kept free of imports so tests can load it, like time-range.ts.
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let chosen: string | null = null;
const formats = new Map<string, Intl.DateTimeFormat>();
let partsFormat: Intl.DateTimeFormat | undefined;

/** The browser's own zone, such as "America/New_York". */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The zone the dashboard uses now. */
const timeZone = () => chosen ?? browserTimeZone();

/** The zone the person picked, or null when it follows the browser. */
export const chosenTimeZone = () => chosen;

/** Sets the zone from the signed-in user, or back to the browser's with null. */
export function setTimeZone(zone: string | null | undefined) {
  const next = zone || null;
  if (next === chosen) return;
  chosen = next;
  formats.clear();
  offsets.clear();
  partsFormat = undefined;
}

/** A formatter for the dashboard's zone, made once per set of options. */
export function zoneFormat(options: Intl.DateTimeFormatOptions = {}) {
  const key = JSON.stringify(options);
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, { ...options, timeZone: timeZone() });
    formats.set(key, format);
  }
  return format;
}

/** A moment in the dashboard's zone, in `options`' shape: `formatTime(ms, { hour: "numeric" })`. */
export const formatTime = (ms: number | string | Date, options?: Intl.DateTimeFormatOptions) =>
  zoneFormat(options).format(new Date(ms));

/** "11/14/2026" (as the locale writes dates). */
export const formatDate = (ms: number | string | Date) => formatTime(ms, { dateStyle: "short" });

/** "11/14/2026, 3:04:05 PM" (as the locale writes them). */
export const formatDateTime = (ms: number | string | Date) =>
  formatTime(ms, { dateStyle: "short", timeStyle: "medium" });

type Parts = {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 for Sunday to 6 for Saturday. */
  weekday: number;
};

// Zones only change offset on the hour or half hour, so the offset is read once per half hour
// and the wall clock worked out from it, which keeps per-row headings and chart buckets cheap.
const HALF_HOUR_MS = HOUR_MS / 2;
const offsets = new Map<number, number>();

/** The zone's minutes east of UTC at `ms`. */
export function zoneOffset(ms: number) {
  const slot = Math.floor(ms / HALF_HOUR_MS);
  let offset = offsets.get(slot);
  if (offset === undefined) {
    // English numerals whatever the locale, so they parse.
    partsFormat ??= new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone(),
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    const at = slot * HALF_HOUR_MS;
    const p: Record<string, string> = {};
    for (const { type, value } of partsFormat.formatToParts(at)) p[type] = value;
    const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!);
    offset = Math.round((wall - at) / 60_000);
    if (offsets.size > 10_000) offsets.clear();
    offsets.set(slot, offset);
  }
  return offset;
}

/** The wall clock in the dashboard's zone at `ms`. */
export function zoneParts(ms: number): Parts {
  const wall = new Date(ms + zoneOffset(ms) * 60_000);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    weekday: wall.getUTCDay(),
  };
}

/**
 * The moment the zone's clock reads this wall time. Days and hours past the end of their unit roll
 * over, as with `Date.UTC`.
 */
function zonedTime(year: number, month: number, day: number, hour = 0) {
  const wall = Date.UTC(year, month - 1, day, hour);
  // The offset at the guess, then again at the answer in case a daylight saving change sits between.
  const guess = wall - zoneOffset(wall) * 60_000;
  return wall - zoneOffset(guess) * 60_000;
}

/** Midnight in the dashboard's zone of the day `ms` falls in, `addDays` days on. */
export function startOfDay(ms: number, addDays = 0) {
  const { year, month, day } = zoneParts(ms);
  return zonedTime(year, month, day + addDays);
}

/** The start of the `hours`-hour block (1, 6 or 12, counted from midnight) `ms` falls in. */
export function startOfHours(ms: number, hours = 1) {
  const { year, month, day, hour } = zoneParts(ms);
  return zonedTime(year, month, day, hour - (hour % hours));
}

/** Midnight on the Monday of the week `ms` falls in. */
export function startOfWeek(ms: number) {
  return startOfDay(ms, -((zoneParts(ms).weekday + 6) % 7));
}

/** Midnight on the first of the month `ms` falls in, `addMonths` months on. */
export function startOfMonth(ms: number, addMonths = 0) {
  const { year, month } = zoneParts(ms);
  return zonedTime(year, month + addMonths, 1);
}

/** `YYYY-MM-DD` for the day `ms` falls in. */
export function dateText(ms: number) {
  const { year, month, day } = zoneParts(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Midnight of a `YYYY-MM-DD` day, or NaN when it isn't a real day. */
export function parseDateText(text: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return Number.NaN;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCDate() !== day) return Number.NaN;
  return zonedTime(year, month, day);
}

/** A day as "Nov 14". */
export const shortDate = (ms: number) => formatTime(ms, { month: "short", day: "numeric" });

/** A list's heading for the day `ms` falls in: "Today", "Yesterday", "Nov 14", "Nov 14, 2025". */
export function dayHeading(ms: number, now = Date.now()) {
  const today = startOfDay(now);
  const day = startOfDay(ms);
  if (day === today) return "Today";
  if (day === startOfDay(today - DAY_MS / 2)) return "Yesterday";
  return zoneParts(ms).year === zoneParts(now).year
    ? shortDate(ms)
    : formatTime(ms, { month: "short", day: "numeric", year: "numeric" });
}

/** Every zone the runtime knows, for the picker. */
export function timeZones(): string[] {
  const all = Intl.supportedValuesOf?.("timeZone") ?? [];
  const browser = browserTimeZone();
  return all.includes(browser) ? all : [browser, ...all];
}

/** "GMT-5" or "GMT+5:30": the zone's offset from UTC now. */
export function offsetName(zone: string, now = Date.now()) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((each) => each.type === "timeZoneName");
  return part?.value === "GMT" ? "GMT+0" : (part?.value ?? "");
}
