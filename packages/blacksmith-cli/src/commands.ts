// The only Blacksmith CLI commands the container runs, and how it reads their results. Kept apart
// from the server so they can be tested without spawning anything.
//
// The org token can also start testboxes and delete caches and sticky disks, so nothing here takes
// a command or flags from the request: each argument list is built from validated fields.

const DAY_MS = 86_400_000;

// `jobs list` only takes a lookback window, not a start time.
const JOB_WINDOWS = [
  { since: "24h", ms: DAY_MS },
  { since: "7d", ms: 7 * DAY_MS },
  { since: "14d", ms: 14 * DAY_MS },
  { since: "30d", ms: 30 * DAY_MS },
] as const;

export const JOBS_PAGE_SIZE = 100;
// A runaway pager stops here.
export const MAX_JOB_PAGES = 50;

// A GitHub organization login, which is also the Blacksmith organization's slug.
const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const validOrganization = (value: unknown): value is string =>
  typeof value === "string" && ORGANIZATION.test(value);

/** A UTC time as RFC 3339 without milliseconds, or null when it isn't a date. */
export function rfc3339(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Log in with the token on stdin, so it's never in an argument list or the environment. */
export const loginArgs = (organization: string) => [
  "auth",
  "login",
  "--api-token",
  "-",
  "--non-interactive",
  "--organization",
  organization,
];

export const verifyArgs = () => ["usage", "--since", "24h", "--format", "json"];

export const usageArgs = (start: string, end: string) => [
  "usage",
  "--start-time",
  start,
  "--end-time",
  end,
  "--breakdown-by",
  "day",
  "--format",
  "json",
];

/** The smallest lookback that reaches `start`, or the longest one there is. */
export function jobsSince(start: Date, now: Date): string {
  const reach = now.getTime() - start.getTime();
  return (JOB_WINDOWS.find((window) => window.ms >= reach) ?? JOB_WINDOWS.at(-1)!).since;
}

export const jobsArgs = (since: string, cursor: string | null) => [
  "jobs",
  "list",
  "--since",
  since,
  "--limit",
  String(JOBS_PAGE_SIZE),
  "--format",
  "json",
  ...(cursor ? ["--cursor", cursor] : []),
];

/**
 * The cursor for the next page, or null to stop: no more pages, or this page already reaches
 * back before `start` (pages come newest first).
 */
export function nextCursor(page: unknown, start: Date): string | null {
  if (!page || typeof page !== "object") return null;
  const { jobs, next_cursor: cursor } = page as { jobs?: unknown; next_cursor?: unknown };
  if (typeof cursor !== "string" || !cursor) return null;
  const times = (Array.isArray(jobs) ? jobs : [])
    .map((job) => new Date((job as { created_at?: string })?.created_at ?? "").getTime())
    .filter((time) => !Number.isNaN(time));
  if (times.length > 0 && Math.min(...times) < start.getTime()) return null;
  return cursor;
}

// What the CLI says when it refuses a token. Its exact wording isn't documented, so this errs
// toward calling a failure an auth failure only when it says so.
const AUTH_FAILURE =
  /\b(401|403)\b|unauthori[sz]ed|unauthenticated|forbidden|invalid (api )?token|token (is )?(invalid|expired|revoked)/i;

export const isAuthFailure = (output: string) => AUTH_FAILURE.test(output);

/** Output with the token taken out, trimmed to what's worth sending back. */
export function scrub(output: string, token: string): string {
  let clean = output;
  for (const secret of [token, token.split("|").at(-1) ?? ""])
    if (secret.length >= 8) clean = clean.split(secret).join("[token]");
  return clean.trim().slice(-500);
}
