/** A non-2xx response. `code` is the gateway's `{ error }` value, when it sent one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

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
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const error = new ApiError(
      `API ${res.status} ${res.statusText} for ${path}`,
      res.status,
      body?.error,
    );
    errorListener?.(error, path);
    throw error;
  }
  return (await res.json()) as T;
}

/** What went wrong, in words: `messages` for the API's error codes, else the error's own message. */
export function errorText(caught: unknown, messages: Record<string, string> = {}) {
  const code = caught instanceof ApiError ? caught.code : undefined;
  return (code && messages[code]) ?? (caught instanceof Error ? caught.message : String(caught));
}
