// A report's time window, from the URL: a calendar range the dashboard worked out in the reader's
// time zone (`?from=&to=`), or the last few days (`?days=N`, as older links and agents send), and
// the window its trend compares against.
import { AppError } from "@relayrunner/errors";
import { z } from "zod";
import { DAY_MS, RAW_RETENTION_DAYS } from "./time.ts";

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

/**
 * A window and the one before it that its trend compares against, just as long: the same stretch of
 * last month for this month (Nov 1–20 against Oct 1–20), or the days right before a rolling range.
 */
export interface ReportWindow extends Window {
  prior: Window;
}

/** The window before `window`: from `priorFrom` (the stretch right before by default), as long. */
export function withPrior(window: Window, priorFrom = 2 * window.from - window.to): ReportWindow {
  // Last month against the month before can be a day longer than it: stop where the window starts.
  const to = Math.min(window.from, priorFrom + window.to - window.from);
  return { ...window, prior: { from: priorFrom, to } };
}

/** Whether a window's trend can be worked out from single jobs, which job_timing keeps a while. */
export const hasTrend = ({ prior }: ReportWindow, now = Date.now()) =>
  prior.from >= now - RAW_RETENTION_DAYS * DAY_MS;

/** A moment in epoch ms, from the URL. */
export const Epoch = z.coerce.number().int().min(0);
const WindowQuery = z.object({ from: Epoch, to: Epoch, priorFrom: Epoch.optional() });

/**
 * A report's window: `?from=&to=` in epoch ms (a calendar range such as this month, worked out in
 * the reader's time zone, with `?priorFrom=` where its trend starts), or else the last `?days=N`.
 * Null when it isn't one, or reaches further back than `maxDays`.
 */
export function parseWindow(
  query: Record<string, string>,
  { maxDays, defaultDays }: { maxDays: number; defaultDays: number },
  now = Date.now(),
): ReportWindow | null {
  if (query.from === undefined && query.to === undefined) {
    const days = z.coerce.number().int().min(1).max(maxDays).default(defaultDays);
    const parsed = days.safeParse(query.days);
    return parsed.success ? withPrior(lastDays(parsed.data, now)) : null;
  }
  const parsed = WindowQuery.safeParse(query);
  if (!parsed.success) return null;
  const { from, priorFrom } = parsed.data;
  const to = Math.min(parsed.data.to, now);
  // A day of slack on `from`, so a calendar month that starts at the reader's midnight still fits.
  if (from >= to || from < now - (maxDays + 1) * DAY_MS) return null;
  if (priorFrom !== undefined && priorFrom >= from) return null;
  return withPrior({ from, to }, priorFrom);
}

/** parseWindow for a route: a request that isn't a window is turned down. */
export function requireWindow(...args: Parameters<typeof parseWindow>) {
  const window = parseWindow(...args);
  if (!window) throw new AppError("INVALID_REQUEST");
  return window;
}
