// What trace export (src/telemetry/export.ts) and log export (src/telemetry/logs.ts) share: which
// workspaces export, the saved endpoint and its sealed headers, the POST, and the export's health.
// Both signals go to one endpoint, so one failing or pausing counts for both.
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { cachedRead } from "../d1-cache.ts";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { DAY_MS } from "../job-timings.ts";
import { openToken } from "../provider-tokens.ts";
import { errorMessage } from "../webhook-queue.ts";

// The associated data the headers are sealed with (src/provider-tokens.ts), so they can't be moved
// onto a provider connection or another workspace.
export const HEADERS_PURPOSE = "telemetry";
// An export that has only failed for this long pauses, so a revoked key doesn't keep costing a
// request per batch forever.
const FAILING_DAYS = 3;
// A working export notes when it last sent at most this often, not on every batch.
const SENT_EVERY_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

type ExportRow = typeof schema.telemetryExport.$inferSelect;

/** What a workspace exports: traces, and which jobs' logs. A paused export sends neither. */
export interface Exporting {
  workspaceId: string;
  traces: boolean;
  logs: ExportRow["logs"];
}

// The installations whose workspace exports traces or logs, by installation id, reused per isolate:
// every finished job asks, and almost none export. Saving or removing an export forgets it here;
// other isolates catch up within a minute, and the queue consumers check the row again before
// sending.
export const exportingInstallations = cachedRead(
  "telemetry exports",
  async (db) => {
    const t = schema.telemetryExport;
    const rows = await db
      .select({
        installationId: schema.workspace.installationId,
        workspaceId: t.workspaceId,
        traces: t.enabled,
        logs: t.logs,
      })
      .from(t)
      .innerJoin(schema.workspace, eq(schema.workspace.id, t.workspaceId))
      .where(and(isNull(t.pausedAt), or(eq(t.enabled, true), ne(t.logs, "off"))));
    return new Map<number, Exporting>(
      rows.map(({ installationId, ...row }) => [installationId, row]),
    );
  },
  () => new Map<number, Exporting>(),
);

/** What the installation's workspace exports, or undefined when nothing. Never throws. */
export async function exportingFor(db: Db, installationId: number | null) {
  if (!installationId) return undefined;
  try {
    return (await exportingInstallations.load(db)).get(installationId);
  } catch (error) {
    console.warn(JSON.stringify({ msg: "couldn't read exports", error: errorMessage(error) }));
    return undefined;
  }
}

/**
 * Where OTLP/HTTP sends a signal for a configured endpoint. An endpoint saved with a signal's path
 * on it, such as …/v1/traces, still works for the other.
 */
export function otlpUrl(endpoint: string, signal: "traces" | "logs") {
  const base = endpoint.replace(/\/+$/, "").replace(/\/v1\/(?:traces|logs)$/, "");
  return `${base}/v1/${signal}`;
}

export type SendResult = { ok: true } | { ok: false; retry: boolean; error: string };

/**
 * POST an OTLP/HTTP JSON body, gzipped when it's bytes. 429, 5xx and network errors are worth
 * retrying; other refusals aren't.
 */
export async function postOtlp(
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array<ArrayBuffer>,
  fetcher: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(typeof body !== "string" && { "content-encoding": "gzip" }),
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true };
    const text = (await response.text().catch(() => "")).trim().slice(0, 300);
    return {
      ok: false,
      retry: response.status === 429 || response.status >= 500,
      error: `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`.trim(),
    };
  } catch (error) {
    return { ok: false, retry: true, error: errorMessage(error) };
  }
}

export function openHeaders(env: Env, row: Pick<ExportRow, "workspaceId" | "headers">) {
  return openToken(env, row.workspaceId, HEADERS_PURPOSE, row.headers).then(
    (json) => JSON.parse(json) as Record<string, string>,
  );
}

/**
 * Note how a send went: a success clears the error, a failure records it, and an export that has
 * only failed for FAILING_DAYS pauses, which stops traces and logs until the settings are saved
 * again.
 */
export async function recordSend(db: Db, workspaceId: string, sent: SendResult, now = new Date()) {
  const where = eq(schema.telemetryExport.workspaceId, workspaceId);
  if (sent.ok) {
    const t = schema.telemetryExport;
    await db
      .update(t)
      .set({ lastSentAt: now, error: null, failingSince: null })
      .where(
        and(
          where,
          or(
            isNotNull(t.error),
            isNull(t.lastSentAt),
            lt(t.lastSentAt, new Date(now.getTime() - SENT_EVERY_MS)),
          ),
        ),
      );
    return;
  }
  const since = sql`coalesce(${schema.telemetryExport.failingSince}, ${now.getTime()})`;
  const stale = sql`${since} <= ${now.getTime() - FAILING_DAYS * DAY_MS}`;
  await db
    .update(schema.telemetryExport)
    .set({
      error: sent.error,
      failingSince: since,
      pausedAt: sql`case when ${stale} then ${now.getTime()} else ${schema.telemetryExport.pausedAt} end`,
    })
    .where(where);
}
