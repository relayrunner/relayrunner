// Settings → Telemetry: where a workspace sends its traces. Header values go in encrypted and never
// come back out (src/provider-tokens.ts); the dashboard sees each header's name and last four
// characters, and leaves a value blank to keep the saved one.
import { eq } from "drizzle-orm";
import type { JobLogChoice } from "@relayrunner/activity";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { sealToken, tokenHint } from "../provider-tokens.ts";
import { sendSpans } from "./export.ts";
import {
  type DestinationChange,
  destinationChanges,
  exportingInstallations,
  exportRow,
  type ExportStatusView,
  HEADERS_PURPOSE,
  NO_STATUS,
  openHeaders,
  recordSend,
  RESET_STATUS,
  type SendResult,
  statusView,
} from "./otlp.ts";
import { testLogs } from "./logs.ts";
import { testSpans } from "./spans.ts";

export const DEFAULT_SERVICE_NAME = "github-actions";

// `logs`: which finished jobs' logs go out too.
export interface TelemetryView extends ExportStatusView {
  configured: boolean;
  endpoint: string;
  headers: { name: string; hint: string }[];
  serviceName: string;
  enabled: boolean;
}

type Row = typeof schema.telemetryExport.$inferSelect;

const NOT_CONFIGURED: TelemetryView = {
  ...NO_STATUS,
  configured: false,
  endpoint: "",
  headers: [],
  serviceName: DEFAULT_SERVICE_NAME,
  enabled: false,
};

function present(row: Row | undefined): TelemetryView {
  if (!row) return NOT_CONFIGURED;
  return {
    ...statusView(row),
    configured: true,
    endpoint: row.endpoint,
    headers: row.headerHints,
    serviceName: row.serviceName,
    enabled: row.enabled,
  };
}

const load = exportRow;

export async function telemetryView(db: Db, workspaceId: string) {
  return present(await load(db, workspaceId));
}

/**
 * Why an endpoint can't be used, or null when it can: https only, a host name rather than an IP,
 * no credentials in the URL, and not RelayRunner itself.
 */
export function endpointProblem(endpoint: string, credentials = "in a header"): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "Enter a full URL, like https://api.honeycomb.io";
  }
  if (url.protocol !== "https:") return "The endpoint must use https";
  if (url.username || url.password) return `Put credentials ${credentials}, not the URL`;
  // "localhost." is localhost.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return "Use a host name, not an IP address";
  if (host === "localhost" || host.endsWith(".local") || !host.includes("."))
    return "The endpoint must be reachable on the internet";
  if (["relayrunner.app", "relayrunner.dev"].some((d) => host === d || host.endsWith(`.${d}`)))
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
  // Left out, the saved choice stays (off for a new export).
  logs?: JobLogChoice;
}

export type SaveResult =
  // `previousLogs` and `changes`: the logs choice before this save, and whether it moved the
  // endpoint or changed its headers, for Activity.
  | { ok: true; telemetry: TelemetryView; previousLogs: JobLogChoice; changes: DestinationChange[] }
  | {
      ok: false;
      error: "TELEMETRY_ENDPOINT_INVALID" | "TELEMETRY_HEADER_MISSING";
      message: string;
    };

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
  if (problem) return { ok: false, error: "TELEMETRY_ENDPOINT_INVALID", message: problem };
  const existing = await load(db, workspaceId);
  const saved = existing ? await openHeaders(env, existing) : {};
  const headers: Record<string, string> = {};
  for (const { name, value } of input.headers) {
    const kept = value || saved[name];
    if (!kept)
      return {
        ok: false,
        error: "TELEMETRY_HEADER_MISSING",
        message: `Enter a value for ${name}.`,
      };
    headers[name] = kept;
  }
  const key = (all: Record<string, string>) => JSON.stringify(Object.entries(all).sort());
  const changes = destinationChanges(
    existing ? { place: existing.endpoint, key: key(saved) } : null,
    { place: endpoint, key: key(headers) },
  );
  const values = {
    endpoint,
    headers: await sealToken(env, workspaceId, HEADERS_PURPOSE, JSON.stringify(headers)),
    headerHints: Object.entries(headers).map(([name, value]) => ({ name, hint: tokenHint(value) })),
    serviceName: input.serviceName.trim() || DEFAULT_SERVICE_NAME,
    enabled: input.enabled,
    logs: input.logs ?? existing?.logs ?? "off",
    ...RESET_STATUS,
  };
  await db
    .insert(schema.telemetryExport)
    .values({ workspaceId, createdBy: userId, ...values })
    .onConflictDoUpdate({ target: schema.telemetryExport.workspaceId, set: values });
  exportingInstallations.forget();
  return {
    ok: true,
    telemetry: await telemetryView(db, workspaceId),
    previousLogs: existing?.logs ?? "off",
    changes,
  };
}

/** Remove the workspace's export. Answers the logs choice it had, for Activity. */
export async function deleteTelemetry(db: Db, workspaceId: string) {
  const [removed] = await db
    .delete(schema.telemetryExport)
    .where(eq(schema.telemetryExport.workspaceId, workspaceId))
    .returning({ logs: schema.telemetryExport.logs });
  exportingInstallations.forget();
  return { telemetry: NOT_CONFIGURED, previousLogs: removed?.logs ?? "off" };
}

/**
 * Send a small test trace with the saved settings, and a test log when logs are on, and record how
 * it went. Null when unset.
 */
export async function testTelemetry(
  env: Env,
  db: Db,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<{ sent: SendResult; telemetry: TelemetryView } | null> {
  const row = await load(db, workspaceId);
  if (!row) return null;
  const headers = await openHeaders(env, row);
  let sent = await sendSpans(
    row,
    headers,
    [{ resource: { "relayrunner.test": true }, spans: await testSpans() }],
    fetcher,
  );
  if (sent.ok && row.logs !== "off") sent = await testLogs(row, headers, fetcher);
  // A test that works also brings a paused export's status back; it doesn't turn it on.
  await recordSend(db, workspaceId, sent, schema.telemetryExport);
  return { sent, telemetry: await telemetryView(db, workspaceId) };
}
