import { AppError } from "@relayrunner/errors";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The API's one error answer. Routes throw AppError (`throw new AppError("NOT_FOUND")`); anything
 * else thrown becomes INTERNAL_ERROR, with the real error in the logs and not in the response.
 */
export function respondError(c: Context, error: unknown) {
  const appError =
    error instanceof AppError ? error : new AppError("INTERNAL_ERROR", { cause: error });
  if (appError.status >= 500) {
    const cause = appError.cause ?? appError;
    console.error(
      JSON.stringify({
        msg: "request failed",
        code: appError.code,
        path: c.req.path,
        error: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack : undefined,
      }),
    );
  }
  if (appError.retryAfter !== undefined) c.header("retry-after", String(appError.retryAfter));
  return c.json(appError.toJSON(), appError.status as ContentfulStatusCode);
}
