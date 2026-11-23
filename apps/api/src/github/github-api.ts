// The one way the API calls GitHub's REST API: headers, the errors callers check for, and list
// pages with their ETag cache. The calls themselves live by area: github-app.ts (the App and its
// installations), actions-api.ts, runners-api.ts, repos-api.ts and billing-api.ts.

import { AppError } from "@relayrunner/errors";

const API = "https://api.github.com";

interface GitHubRequest {
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  accept?: string;
  etag?: string;
  /**
   * Statuses answered rather than thrown, such as 404 for "gone". `"any"` throws for none, for a
   * call whose refusal is a result (refusalMessage) rather than an error.
   */
  allow?: number[] | "any";
}

/** Calls GitHub with `token`. Throws githubError unless the answer is ok or `allow`ed. */
export async function githubFetch(
  token: string,
  path: string,
  { method = "GET", body, accept, etag, allow = [] }: GitHubRequest = {},
) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: accept ?? "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "relayrunner-gateway",
      "x-github-api-version": "2022-11-28",
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(etag && { "if-none-match": etag }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && allow !== "any" && !allow.includes(response.status))
    throw await githubError(method, path, response);
  return response;
}

export async function getJson<T>(token: string, path: string): Promise<T> {
  return (await (await githubFetch(token, path)).json()) as T;
}

/** A GET's body, or null when GitHub answers 404. */
export async function getJsonOrNull<T>(token: string, path: string) {
  const response = await githubFetch(token, path, { allow: [404] });
  return response.status === 404 ? null : ((await response.json()) as T);
}

export async function sendJson<T>(token: string, method: string, path: string, body?: unknown) {
  return (await (await githubFetch(token, path, { method, body })).json()) as T;
}

/** GitHub's own words for a refused call, else `fallback`. */
export async function refusalMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : fallback;
}

/** A DELETE where already gone (404) counts as done. */
export async function deleteIfPresent(token: string, path: string) {
  await githubFetch(token, path, { method: "DELETE", allow: [404] });
}

// listAll's cap: 10 pages of 100.
export const MAX_LISTED = 1000;

// Every page of a list endpoint whose response holds its items under `key`, or is the list itself
// without one. Capped at MAX_LISTED, far more runners or groups than an org that adds runners by
// hand has.
// `cache` false skips the ETag cache, for pages read once that would push out ones polled often.
// `max` lifts the cap for lists that must be whole, such as every installation of the App.
export async function listAll<T>(
  token: string,
  path: string,
  key?: string,
  { cache = true, max = MAX_LISTED } = {},
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= max / 100; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const pagePath = `${path}${separator}per_page=100&page=${page}`;
    const body = (await (cache ? getPage(token, pagePath) : getJson(token, pagePath))) as Record<
      string,
      unknown
    >;
    const batch = ((key ? body[key] : body) ?? []) as T[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

// The last body and ETag of each listed page, by path, kept for the isolate's life. Asking again
// with the ETag gets a 304 when nothing changed, which GitHub doesn't count against the
// installation's rate limit, so polling runner lists stays nearly free. Oldest dropped past
// MAX_CACHED_PAGES.
const listedPages = new Map<string, { etag: string; body: unknown }>();
const MAX_CACHED_PAGES = 500;

/** Forget cached list pages. For tests. */
export function clearListedPages() {
  listedPages.clear();
}

// One page of a list, reusing the cached body when GitHub says it hasn't changed.
async function getPage(token: string, path: string): Promise<unknown> {
  const cached = listedPages.get(path);
  const response = await githubFetch(token, path, {
    etag: cached?.etag,
    allow: cached ? [304] : [],
  });
  if (response.status === 304 && cached) return cached.body;
  const body: unknown = await response.json();
  const etag = response.headers.get("etag");
  listedPages.delete(path);
  if (etag) {
    listedPages.set(path, { etag, body });
    if (listedPages.size > MAX_CACHED_PAGES) listedPages.delete(listedPages.keys().next().value!);
  }
  return body;
}

/** A failed GitHub call, with GitHub's status. A rate limit is GitHubRateLimitError instead. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when GitHub refuses a call for the token's permissions (403) or can't see it (404). */
export class GitHubAccessError extends GitHubError {
  constructor(message: string, status: number) {
    super(status, message);
  }
}

/**
 * Thrown when GitHub refuses a call because the installation ran out of API calls: its hourly
 * limit, or a secondary limit for too many calls at once. Reaching a route, it answers
 * GITHUB_RATE_LIMITED with a `Retry-After` from GitHub's own headers. GitHub's answer is the cause.
 */
export class GitHubRateLimitError extends AppError {
  constructor(detail: string, response?: Response) {
    super("GITHUB_RATE_LIMITED", {
      cause: new Error(detail),
      retryAfter: response && retryAfterSeconds(response),
    });
  }
}

// Seconds until GitHub takes calls again: its `retry-after` (secondary limits), else the time to
// `x-ratelimit-reset` (the hourly limit).
function retryAfterSeconds(response: Response): number | undefined {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return undefined;
  return Math.max(1, Math.ceil(reset - Date.now() / 1000));
}

/** The error for a failed GitHub call: rate limited, refused (403 or 404), or any other. */
async function githubError(method: string, path: string, response: Response) {
  const message = `${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`;
  if (isRateLimited(response)) return new GitHubRateLimitError(message, response);
  if (response.status === 403 || response.status === 404)
    return new GitHubAccessError(message, response.status);
  return new GitHubError(response.status, message);
}

// GitHub answers a spent limit with 429, or with 403 and either no calls remaining or a
// `retry-after` (a secondary limit). A 403 without either is a missing permission.
function isRateLimited(response: Response) {
  if (response.status === 429) return true;
  return (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))
  );
}
