// What trace export (src/telemetry/export.ts) and log export (src/telemetry/logs.ts) share: which
// workspaces export, the saved endpoint and its sealed headers, the POST, and the export's health.
// Both signals go to one endpoint, so one failing or pausing counts for both.
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { cachedRead } from "../d1-cache.ts";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { DAY_MS } from "../time.ts";
import { openToken } from "../provider-tokens.ts";
import { errorMessage } from "../webhook-queue.ts";

// The associated data the headers are sealed with (src/provider-tokens.ts), so they can't be moved
// onto a provider connection or another workspace.
export const HEADERS_PURPOSE = "telemetry";
// An export that has only failed for this long pauses, so a revoked key doesn't keep costing a
// request per batch forever.
const FAILING_DAYS = 3;
// A gap this long between failures starts a new run of them.
const QUIET_MS = DAY_MS;
// A working export notes when it last sent at most this often, not on every batch.
const SENT_EVERY_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

type ExportRow = typeof schema.telemetryExport.$inferSelect;
type LogChoice = ExportRow["logs"];

/** Where a workspace's telemetry goes: its OTLP endpoint, or the bucket that archives its logs. */
export type ExportTable = typeof schema.telemetryExport | typeof schema.logBucket;

// Both tables share the status columns (exportStatus in db/schema.ts), so either can be updated as
// the other. StatusRow stops compiling if either table loses one of them.
const statusColumns = (table: ExportTable) => table as typeof schema.telemetryExport;
type StatusRow = Pick<
  ExportRow | typeof schema.logBucket.$inferSelect,
  keyof ReturnType<typeof schema.exportStatus>
>;

/** What a save changed about where an export sends: the place, its credentials, or both. */
export type DestinationChange = "place" | "key";

/**
 * Compare an export's saved place and credentials with the new ones. A new export changed
 * nothing: turning it on is its own Activity entry.
 */
export function destinationChanges(
  before: { place: string; key: string } | null,
  after: { place: string; key: string },
): DestinationChange[] {
  if (!before) return [];
  return [
    ...(before.place !== after.place ? (["place"] as const) : []),
    ...(before.key !== after.key ? (["key"] as const) : []),
  ];
}

/** An export's health, as Settings shows it. */
export interface ExportStatusView {
  logs: LogChoice;
  lastSentAt: string | null;
  error: string | null;
  failingSince: string | null;
  // When it turned itself off after failing for days.
  pausedAt: string | null;
  // Why the latest job's log that should have gone out didn't.
  logsSkipped: { reason: string; at: string } | null;
}

export const NO_STATUS: ExportStatusView = {
  logs: "off",
  lastSentAt: null,
  error: null,
  failingSince: null,
  pausedAt: null,
  logsSkipped: null,
};

/** Saving an export's settings starts over: the new settings get a fresh chance. */
export const RESET_STATUS = {
  error: null,
  failingSince: null,
  failedAt: null,
  pausedAt: null,
  logsSkipped: null,
  logsSkippedAt: null,
};

const iso = (date: Date | null) => date?.toISOString() ?? null;

export function statusView(row: StatusRow): ExportStatusView {
  return {
    logs: row.logs,
    lastSentAt: iso(row.lastSentAt),
    error: row.error,
    failingSince: iso(row.failingSince),
    pausedAt: iso(row.pausedAt),
    logsSkipped:
      row.logsSkipped && row.logsSkippedAt
        ? { reason: row.logsSkipped, at: row.logsSkippedAt.toISOString() }
        : null,
  };
}

/** The workspace's OTLP export, if it has one. */
export async function exportRow(db: Db, workspaceId: string) {
  const [row] = await db
    .select()
    .from(schema.telemetryExport)
    .where(eq(schema.telemetryExport.workspaceId, workspaceId))
    .limit(1);
  return row;
}

/** The workspace's log bucket, if it has one. */
export async function bucketRow(db: Db, workspaceId: string) {
  const [row] = await db
    .select()
    .from(schema.logBucket)
    .where(eq(schema.logBucket.workspaceId, workspaceId))
    .limit(1);
  return row;
}

/** Gzip a request or object body. */
export async function gzip(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * What a workspace exports: traces and which jobs' logs to its OTLP endpoint, and which jobs' logs
 * to its bucket. A paused export or bucket sends nothing.
 */
export interface Exporting {
  workspaceId: string;
  traces: boolean;
  logs: LogChoice;
  bucket: LogChoice;
}

// The installations whose workspace exports traces or logs anywhere, by installation id, reused per isolate:
// every finished job asks, and almost none export. Saving or removing an export forgets it here;
// other isolates catch up within a minute, and the queue consumers check the row again before
// sending.
export const exportingInstallations = cachedRead(
  "telemetry exports",
  async (db) => {
    const t = schema.telemetryExport;
    const b = schema.logBucket;
    const [exports, buckets] = await Promise.all([
      db
        .select({
          installationId: schema.workspace.installationId,
          workspaceId: t.workspaceId,
          traces: t.enabled,
          logs: t.logs,
        })
        .from(t)
        .innerJoin(schema.workspace, eq(schema.workspace.id, t.workspaceId))
        .where(and(isNull(t.pausedAt), or(eq(t.enabled, true), ne(t.logs, "off")))),
      db
        .select({
          installationId: schema.workspace.installationId,
          workspaceId: b.workspaceId,
          bucket: b.logs,
        })
        .from(b)
        .innerJoin(schema.workspace, eq(schema.workspace.id, b.workspaceId))
        .where(and(isNull(b.pausedAt), ne(b.logs, "off"))),
    ]);
    const map = new Map<number, Exporting>();
    const entry = (installationId: number, workspaceId: string) =>
      map.get(installationId) ??
      map
        .set(installationId, { workspaceId, traces: false, logs: "off", bucket: "off" })
        .get(installationId)!;
    for (const { installationId, workspaceId, traces, logs } of exports)
      Object.assign(entry(installationId, workspaceId), { traces, logs });
    for (const { installationId, workspaceId, bucket } of buckets)
      entry(installationId, workspaceId).bucket = bucket;
    return map;
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
    return await resultOf(response);
  } catch (error) {
    return { ok: false, retry: true, error: errorMessage(error) };
  }
}

/**
 * How a send went from its response: 429 and 5xx are worth retrying, other refusals aren't. Keeps
 * the start of the body, which usually says why.
 */
export async function resultOf(response: Response): Promise<SendResult> {
  if (response.ok) return { ok: true };
  const text = (await response.text().catch(() => "")).trim().slice(0, 300);
  return {
    ok: false,
    retry: response.status === 429 || response.status >= 500,
    error: `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`.trim(),
  };
}

export function openHeaders(env: Env, row: Pick<ExportRow, "workspaceId" | "headers">) {
  return openToken(env, row.workspaceId, HEADERS_PURPOSE, row.headers).then(
    (json) => JSON.parse(json) as Record<string, string>,
  );
}

/**
 * Note how a send went, on the OTLP export or the bucket: a success clears the
 * error, a failure records it, and one that has only failed for FAILING_DAYS pauses, which stops
 * everything it sends until its settings are saved again.
 */
export async function recordSend(
  db: Db,
  workspaceId: string,
  sent: SendResult,
  table: ExportTable,
  now = new Date(),
) {
  const t = statusColumns(table);
  const where = eq(t.workspaceId, workspaceId);
  if (sent.ok) {
    await db
      .update(t)
      .set({ lastSentAt: now, error: null, failingSince: null, failedAt: null })
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
  // A day without tries, as a bucket that only takes failed jobs' logs can have, starts a new run
  // of failures, so two failures days apart don't add up to a pause.
  // failedAt and failingSince are set and cleared together.
  const ms = now.getTime();
  const quiet = sql`${t.failedAt} is null or ${t.failedAt} < ${ms - QUIET_MS}`;
  const since = sql`case when ${quiet} then ${ms} else ${t.failingSince} end`;
  const stale = sql`${since} <= ${ms - FAILING_DAYS * DAY_MS}`;
  await db
    .update(t)
    .set({
      error: sent.error,
      failingSince: since,
      failedAt: now,
      pausedAt: sql`case when ${stale} then ${ms} else ${t.pausedAt} end`,
    })
    .where(where);
}

/** Note why a job's log that should have gone out didn't. */
export async function recordSkip(
  db: Db,
  workspaceId: string,
  reason: string,
  table: ExportTable,
  now = new Date(),
) {
  const t = statusColumns(table);
  await db
    .update(t)
    .set({ logsSkipped: reason, logsSkippedAt: now })
    .where(eq(t.workspaceId, workspaceId));
}
