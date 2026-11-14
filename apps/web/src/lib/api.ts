import { AppError as ApiError, parseError } from "@relayrunner/errors";

/** A non-2xx response: the API's error code, status and message (@relayrunner/errors). */
export { ApiError };

let errorListener: ((error: ApiError, path: string) => void) | undefined;

/** Hears every non-2xx answer, such as a 401 that means the session ended (lib/session.ts). */
export function onApiError(listener: (error: ApiError, path: string) => void) {
  errorListener = listener;
}

/**
 * Thin fetch wrapper for the gateway API (apps/api), served from /api on the
 * dashboard's origin. Sends cookies so Better Auth sessions apply.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const error = parseError(await res.json().catch(() => null), res.status);
    errorListener?.(error, path);
    throw error;
  }
  return (await res.json()) as T;
}

/**
 * What went wrong, in words: the API's own message, unless `messages` words that code differently
 * for this page.
 */
export function errorText(caught: unknown, messages: Record<string, string> = {}) {
  const code = caught instanceof ApiError ? caught.code : undefined;
  return (code && messages[code]) ?? (caught instanceof Error ? caught.message : String(caught));
}
