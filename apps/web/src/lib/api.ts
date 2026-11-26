import { AppError, parseError } from "@relayrunner/errors";

let errorListener: ((error: AppError, path: string) => void) | undefined;

/** Hears every non-2xx answer, such as a 401 that means the session ended (lib/session.ts). */
export function onApiError(listener: (error: AppError, path: string) => void) {
  errorListener = listener;
}

/**
 * Thin fetch wrapper for the gateway API (apps/api), served from /api on the
 * dashboard's origin. Sends cookies so Better Auth sessions apply.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // The dev preview (VITE_AUTH_DISABLED) has no API behind it: sample data answers instead. Checked
  // here, not through authDisabled, so the build drops the sample module.
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === "true") {
    const { sampleAnswer } = await import("@/lib/sample/answers");
    return sampleAnswer(path, init) as T;
  }
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

/** What went wrong, in words: the API's own message for an API error. */
export function errorText(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}
