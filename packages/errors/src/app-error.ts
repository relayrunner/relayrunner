import { ERRORS, isErrorCode, type ErrorCode } from "./codes.ts";

/** The body of every non-2xx API response. */
export interface ErrorBody {
  error: {
    /** A code from {@link ERRORS}, or a newer one this build doesn't know yet. */
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface AppErrorOptions {
  /** Replaces the code's default message. */
  message?: string;
  /** Structured context for this code, such as validation issues. */
  details?: unknown;
  /** Seconds to wait before asking again; the API sends it as `Retry-After`. */
  retryAfter?: number;
  cause?: unknown;
}

/**
 * A failure with a stable code. Throw it from an API route and the API's error handler answers
 * with the code's status and an {@link ErrorBody}; clients get one back from {@link parseError}.
 */
export class AppError extends Error {
  /** A string rather than ErrorCode: a client can receive codes added after it was built. */
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? ERRORS[code].message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = ERRORS[code].status;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }

  toJSON(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** Whether a response body is an {@link ErrorBody}. */
export function isErrorBody(body: unknown): body is ErrorBody {
  const error = (body as Partial<ErrorBody> | null)?.error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}

/**
 * Reads a non-2xx response body as an AppError. Never throws: a body that isn't an
 * {@link ErrorBody} (a proxy's HTML page, an empty body) keeps the status with a generic message.
 */
export function parseError(body: unknown, status: number): AppError {
  const { code, message, details } = isErrorBody(body)
    ? body.error
    : {
        code: "INTERNAL_ERROR",
        message: `The request failed with status ${status}.`,
        details: undefined,
      };
  const parsed = new AppError(isErrorCode(code) ? code : "INTERNAL_ERROR", { message, details });
  // Keep what the server said, including a code newer than this build.
  return Object.assign(parsed, { status, code });
}

/** An error in one line for an agent or a terminal: "Not found (NOT_FOUND)". */
export function describeError(error: AppError) {
  return `${error.message.replace(/\.$/, "")} (${error.code})`;
}
