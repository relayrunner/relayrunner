import { AppError } from "@relayrunner/errors";
import type { Context } from "hono";
import { log } from "./log.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The API's one error answer. Routes throw AppError (`throw new AppError("NOT_FOUND")`); anything
 * else thrown becomes INTERNAL_ERROR, with the real error in the logs and not in the response.
 */
export function respondError(c: Context, error: unknown) {
  const appError =
    error instanceof AppError ? error : new AppError("INTERNAL_ERROR", { cause: error });
  if (appError.status >= 500) {
    log.error("http.request_failed", "request failed", {
      code: appError.code,
      method: c.req.method,
      path: c.req.path,
      error: appError.cause ?? appError,
    });
  }
  if (appError.retryAfter !== undefined) c.header("retry-after", String(appError.retryAfter));
  return c.json(appError.toJSON(), appError.status as ContentfulStatusCode);
}

// An error's message, with its cause's when it has one (a GitHubRateLimitError keeps GitHub's
// answer there).
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error
    ? `${error.message} (${errorMessage(error.cause)})`
    : error.message;
}
