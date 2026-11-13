// What every provider adapter returns, and the HTTP plumbing they share. Each adapter talks to one
// provider's public API with the workspace's read-only token and turns its answer into these rows;
// src/provider-sync.ts stores them.

/** One job the provider ran, keyed by GitHub's job id. */
export interface JobUsage {
  jobId: string;
  runId: string | null;
  repository: string | null;
  jobName: string | null;
  runnerLabel: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  billableSeconds: number | null;
  queueSeconds: number | null;
  costUsd: number | null;
}

/** The provider's own total for one UTC day, in its own unit. */
export interface DailyUsage {
  day: Date;
  unit: string;
  quantity: number;
  costUsd: number | null;
}

export interface Usage {
  jobs: JobUsage[];
  days: DailyUsage[];
}

export interface UsageWindow {
  start: Date;
  end: Date;
}

export interface BillingAdapter {
  /** One cheap read that proves the token works. Names the account when the provider says. */
  verify(ctx: AdapterContext): Promise<{ accountName: string | null }>;
  /** Jobs and daily totals in the window. */
  usage(ctx: AdapterContext, window: UsageWindow): Promise<Usage>;
}

export interface AdapterContext {
  token: string;
  options: Record<string, string>;
  fetch: typeof fetch;
}

/** The provider refused the token: it's wrong, revoked or lacks the scope. */
export class ProviderAuthError extends Error {}

/** Any other failed call. */
export class ProviderApiError extends Error {}

const TIMEOUT_MS = 20_000;

/** POST or GET JSON with the token as a bearer, mapping refusals to ProviderAuthError. */
export async function requestJson<T>(
  ctx: AdapterContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<T> {
  const response = await ctx.fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${ctx.token}`, accept: "application/json", ...init.headers },
    body: init.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

/** A unary Connect RPC call with JSON (https://connectrpc.com/docs/protocol). */
export function connectUnary<T>(ctx: AdapterContext, url: string, body: unknown) {
  return requestJson<T>(ctx, url, {
    method: "POST",
    headers: { "content-type": "application/json", "connect-protocol-version": "1" },
    body: JSON.stringify(body),
  });
}

export async function responseError(response: Response) {
  const body = (await response.text().catch(() => "")).slice(0, 200);
  const message = `${response.status} from ${new URL(response.url || "http://unknown").host}${body ? `: ${body}` : ""}`;
  return response.status === 401 || response.status === 403
    ? new ProviderAuthError(message)
    : new ProviderApiError(message);
}

/** A 64-bit number sent as a JSON number or string (protobuf JSON), or nothing. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function date(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Seconds from one time to another, or null when either is missing. */
export const secondsBetween = (from: Date | null, to: Date | null) =>
  from && to ? Math.max(0, (to.getTime() - from.getTime()) / 1000) : null;

/** UTC midnight of a date. */
export const utcDay = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

// A runaway pager stops here rather than spending the Worker's subrequests.
export const MAX_PAGES = 100;
