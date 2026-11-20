// Time constants, in a module with no imports so any module can use them at load time without an
// import cycle leaving them undefined.
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// How long finished jobs are counted for, as job_timing_daily rows by then. The report's longest
// range is 90 days.
export const JOB_TIMING_RETENTION_DAYS = 90;
// How long a finished job keeps its own job_timing row before its day is rolled up into
// job_timing_daily: job times' longest range (MAX_DAYS in src/job-times.ts) and a day to spare.
// The Runs page and job times read single jobs, so they only look this far back.
export const RAW_RETENTION_DAYS = 31;
