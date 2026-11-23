// Time constants and helpers, with no imports, so any module can use them.
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** The UTC midnight starting the day `ms` falls on. */
export function utcDay(ms: number) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// How long finished jobs are counted for, as job_timing_daily rows by then. The report's longest
// range is 90 days.
export const JOB_TIMING_RETENTION_DAYS = 90;
// How long a finished job keeps its own job_timing row before its day is rolled up into
// job_timing_daily: two months, so last month is still single jobs, and so is this month's trend
// window (the same days of last month). The Runs page and job times read single jobs, so they only
// look this far back.
export const RAW_RETENTION_DAYS = 62;
// How far back a filtered Signals page, a signal's runs and pull request folders look: shorter than
// single jobs are kept, since each of those reads (and GitHub calls) grows with it.
export const LIVE_DAYS = 30;

// A failed queue message's delay before its retry: 30s, 60s, 120s, ... capped at 15 minutes.
// `attempts` starts at 1.
export function retryDelaySeconds(attempts: number) {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 15 * 60);
}
