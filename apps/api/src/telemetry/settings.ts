// Settings → Telemetry: where a workspace sends its traces. Header values go in encrypted and never
// come back out (src/provider-tokens.ts); the dashboard sees each header's name and last four
// characters, and leaves a value blank to keep the saved one.
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { sealToken, tokenHint } from "../provider-tokens.ts";
import { HEADERS_PURPOSE, openHeaders, recordSend, type SendResult, sendSpans } from "./export.ts";
import { testSpans } from "./spans.ts";

export const DEFAULT_SERVICE_NAME = "github-actions";

export interface TelemetryView {
  configured: boolean;
  endpoint: string;
  headers: { name: string; hint: string }[];
  serviceName: string;
  enabled: boolean;
  lastSentAt: string | null;
  error: string | null;
  failingSince: string | null;
  // When it turned itself off after failing for days.
  pausedAt: string | null;
}

type Row = typeof schema.telemetryExport.$inferSelect;

const iso = (date: Date | null) => date?.toISOString() ?? null;

function present(row: Row | undefined): TelemetryView {
  return {
    configured: !!row,
    endpoint: row?.endpoint ?? "",
    headers: row?.headerHints ?? [],
    serviceName: row?.serviceName ?? DEFAULT_SERVICE_NAME,
    enabled: row?.enabled ?? false,
    lastSentAt: iso(row?.lastSentAt ?? null),
    error: row?.error ?? null,
    failingSince: iso(row?.failingSince ?? null),
    pausedAt: iso(row?.pausedAt ?? null),
  };
}

async function load(db: Db, workspaceId: string) {
  const [row] = await db
    .select()
    .from(schema.telemetryExport)
    .where(eq(schema.telemetryExport.workspaceId, workspaceId))
    .limit(1);
  return row;
}

export async function telemetryView(db: Db, workspaceId: string) {
  return present(await load(db, workspaceId));
}

/**
 * Why an endpoint can't be used, or null when it can: https only, a host name rather than an IP,
 * no credentials in the URL, and not RelayRunner itself.
 */
export function endpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "Enter a full URL, like https://api.honeycomb.io";
  }
  if (url.protocol !== "https:") return "The endpoint must use https";
  if (url.username || url.password) return "Put credentials in a header, not the URL";
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return "Use a host name, not an IP address";
  if (host === "localhost" || host.endsWith(".local") || !host.includes("."))
    return "The endpoint must be reachable on the internet";
  if (host === "relayrunner.app" || host.endsWith(".relayrunner.app"))
    return "The endpoint can't be RelayRunner itself";
  if (url.search || url.hash) return "Leave the query string out of the endpoint";
  return null;
}

export interface SaveInput {
  endpoint: string;
  // A header without a value keeps the value saved under that name.
  headers: { name: string; value?: string }[];
  serviceName: string;
  enabled: boolean;
}

export type SaveResult =
  | { ok: true; telemetry: TelemetryView }
  | { ok: false; error: "invalid_endpoint" | "missing_header_value"; message: string };

/** Save (or replace) the workspace's export. Throws TokenKeyError when headers can't be sealed. */
export async function saveTelemetry(
  env: Env,
  db: Db,
  workspaceId: string,
  userId: string,
  input: SaveInput,
): Promise<SaveResult> {
  const endpoint = input.endpoint.trim().replace(/\/+$/, "");
  const problem = endpointProblem(endpoint);
  if (problem) return { ok: false, error: "invalid_endpoint", message: problem };
  const existing = await load(db, workspaceId);
  const saved = existing ? await openHeaders(env, existing) : {};
  const headers: Record<string, string> = {};
  for (const { name, value } of input.headers) {
    const kept = value || saved[name];
    if (!kept)
      return { ok: false, error: "missing_header_value", message: `Enter a value for ${name}` };
    headers[name] = kept;
  }
  const values = {
    endpoint,
    headers: await sealToken(env, workspaceId, HEADERS_PURPOSE, JSON.stringify(headers)),
    headerHints: Object.entries(headers).map(([name, value]) => ({ name, hint: tokenHint(value) })),
    serviceName: input.serviceName.trim() || DEFAULT_SERVICE_NAME,
    enabled: input.enabled,
    // Saving starts over: the new settings get a fresh chance.
    error: null,
    failingSince: null,
    pausedAt: null,
  };
  await db
    .insert(schema.telemetryExport)
    .values({ workspaceId, createdBy: userId, ...values })
    .onConflictDoUpdate({ target: schema.telemetryExport.workspaceId, set: values });
  return { ok: true, telemetry: await telemetryView(db, workspaceId) };
}

export async function deleteTelemetry(db: Db, workspaceId: string) {
  await db
    .delete(schema.telemetryExport)
    .where(eq(schema.telemetryExport.workspaceId, workspaceId));
  return present(undefined);
}

/** Send a small test trace with the saved settings, and record how it went. Null when unset. */
export async function testTelemetry(
  env: Env,
  db: Db,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<{ sent: SendResult; telemetry: TelemetryView } | null> {
  const row = await load(db, workspaceId);
  if (!row) return null;
  const sent = await sendSpans(
    row,
    await openHeaders(env, row),
    [{ resource: { "relayrunner.test": true }, spans: await testSpans() }],
    fetcher,
  );
  // A test that works also brings a paused export's status back; it doesn't turn it on.
  await recordSend(db, workspaceId, sent);
  return { sent, telemetry: await telemetryView(db, workspaceId) };
}
