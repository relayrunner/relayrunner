import { GitHubError } from "./github/github-api.ts";
import { isOverloaded } from "./db/retry.ts";

/**
 * A failure that trying again usually fixes: GitHub answering 5xx (an outage or a blip), a dropped
 * connection or a timeout, or D1 shedding load for a few seconds. Work that retries logs these as
 * warnings and keeps `error` for when it gives up, so a short outage upstream doesn't alert.
 */
export function isTransient(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 3) return false;
  if (error instanceof GitHubError) return error.status >= 500;
  if (isOverloaded(error)) return true;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (
    /network connection lost|connection (reset|refused|timed out)|fetch failed/i.test(error.message)
  )
    return true;
  return isTransient(error.cause, depth + 1);
}
