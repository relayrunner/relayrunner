// A report's time window, from the URL: a calendar range the dashboard worked out in the reader's
// time zone (`?from=&to=`), or the last few days (`?days=N`, as older links and agents send).
import { z } from "zod";
import { DAY_MS } from "./time.ts";

/** A report's window, in epoch ms: jobs finished at or after `from` and before `to`. */
export interface Window {
  from: number;
  to: number;
}

/** The last `days` days up to `now`. */
export const lastDays = (days: number, now = Date.now()): Window => ({
  from: now - days * DAY_MS,
  to: now,
});

/** How many days a window spans, at least one, for a report's `days`. */
export const windowDays = ({ from, to }: Window) => Math.max(1, Math.round((to - from) / DAY_MS));

/** A moment in epoch ms, from the URL. */
export const Epoch = z.coerce.number().int().min(0);
const WindowQuery = z.object({ from: Epoch, to: Epoch });

/**
 * A report's window: `?from=&to=` in epoch ms (a calendar range such as this month, worked out in
 * the reader's time zone), or else the last `?days=N`. Null when it isn't one, or reaches further
 * back than `maxDays`.
 */
export function parseWindow(
  query: Record<string, string>,
  { maxDays, defaultDays }: { maxDays: number; defaultDays: number },
  now = Date.now(),
): Window | null {
  if (query.from === undefined && query.to === undefined) {
    const days = z.coerce.number().int().min(1).max(maxDays).default(defaultDays);
    const parsed = days.safeParse(query.days);
    return parsed.success ? lastDays(parsed.data, now) : null;
  }
  const parsed = WindowQuery.safeParse(query);
  if (!parsed.success) return null;
  const from = parsed.data.from;
  const to = Math.min(parsed.data.to, now);
  // A day of slack on `from`, so a calendar month that starts at the reader's midnight still fits.
  return from < to && from >= now - (maxDays + 1) * DAY_MS ? { from, to } : null;
}
