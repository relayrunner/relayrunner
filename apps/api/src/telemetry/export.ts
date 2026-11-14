// Sending CI traces to a workspace's OTLP endpoint (Settings → Telemetry). The webhook consumer
// turns each finished job and run into spans (src/telemetry/spans.ts) and queues them here, only
// for workspaces with an export on. This queue's consumer batches them per workspace and POSTs one
// OTLP/HTTP JSON request each. Spans are telemetry, not records: ones that run out of retries are
// dropped, and the run is still in History.
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { environmentFor, environmentProvider, nameMachines } from "../job-times.ts";
import { openToken } from "../provider-tokens.ts";
import { errorMessage, retryDelaySeconds } from "../webhook-queue.ts";
import { cachedRead } from "../d1-cache.ts";
import { DAY_MS } from "../job-timings.ts";
import {
  type Attributes,
  jobSpans,
  otlpRequest,
  type Repository,
  repositoryResource,
  runSpan,
  type Span,
} from "./spans.ts";

export const TELEMETRY_QUEUE = "relayrunner-telemetry";

/** One job's or run's spans, which share a repository and so a resource. */
export interface TelemetryMessage {
  workspaceId: string;
  resource: Attributes;
  spans: Span[];
}

// The associated data the headers are sealed with (src/provider-tokens.ts), so they can't be moved
// onto a provider connection or another workspace.
export const HEADERS_PURPOSE = "telemetry";
// The consumer's max_retries in wrangler.jsonc. With retryDelaySeconds that's about an hour.
const MAX_ATTEMPTS = 8;
// An export that has only failed for this long turns itself off, so a revoked key doesn't keep
// costing a request per batch forever.
const FAILING_DAYS = 3;
// A working export notes when it last sent at most this often, not on every batch.
const SENT_EVERY_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;
type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;
type ExportRow = typeof schema.telemetryExport.$inferSelect;

// The installations whose workspace exports traces, by installation id, reused per isolate: every
// finished job asks, and almost none export. Saving or removing an export forgets it here; other
// isolates catch up within a minute, and the queue consumer checks `enabled` again before sending.
export const exportingInstallations = cachedRead(
  "telemetry exports",
  async (db) => {
    const rows = await db
      .select({
        installationId: schema.workspace.installationId,
        workspaceId: schema.telemetryExport.workspaceId,
      })
      .from(schema.telemetryExport)
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.telemetryExport.workspaceId))
      .where(eq(schema.telemetryExport.enabled, true));
    return new Map(rows.map((row) => [row.installationId, row.workspaceId]));
  },
  () => new Map<number, string>(),
);

/**
 * Queue one job's or run's spans, when its installation's workspace exports traces. Never throws:
 * a retried webhook would redo everything else for it.
 */
async function queueSpans(
  env: Env,
  db: Db,
  message: { installationId: number | null; repository: Repository },
  spansFor: (workspaceId: string) => Promise<Span[]>,
) {
  try {
    const workspaceId =
      message.installationId && (await exportingInstallations.load(db)).get(message.installationId);
    if (!workspaceId) return;
    const spans = await spansFor(workspaceId);
    if (spans.length)
      await env.TELEMETRY_QUEUE.send({
        workspaceId,
        resource: repositoryResource(message.repository),
        spans,
      });
  } catch (error) {
    console.warn(JSON.stringify({ msg: "couldn't queue spans", error: errorMessage(error) }));
  }
}

/** Queue a finished job's spans, when its workspace exports traces. */
export async function exportJob(env: Env, db: Db, message: WorkflowJobMessage) {
  const { job, repository } = message;
  if (job.status !== "completed") return;
  await queueSpans(env, db, message, async (workspaceId) => {
    const [timing] = await db
      .select({ machineId: schema.jobTiming.machineId, usage: schema.jobTiming.usage })
      .from(schema.jobTiming)
      .where(eq(schema.jobTiming.id, job.id))
      .limit(1);
    let ranOn: { provider: string; runner: string } | null = null;
    if (job.startedAt) {
      const ran = environmentFor(
        job.labels,
        job.runnerGroupName ?? null,
        timing?.machineId ?? null,
      );
      await nameMachines(db, workspaceId, new Map([[ran.key, ran]]));
      ranOn = { provider: environmentProvider(ran), runner: ran.label };
    }
    return jobSpans({ repository, job, ranOn, usage: timing?.usage ?? null });
  });
}

/** Queue a finished run's root span, when its workspace exports traces. */
export async function exportRun(env: Env, db: Db, message: WorkflowRunMessage) {
  const { run, repository } = message;
  if (run.status !== "completed") return;
  await queueSpans(env, db, message, async () => {
    const ofRun = (table: typeof schema.routeDecision | typeof schema.jobRetry, attempt: number) =>
      and(
        eq(table.repositoryId, repository.id),
        eq(table.runId, run.id),
        eq(table.runAttempt, attempt),
      );
    const [[decision], [retried]] = await Promise.all([
      db
        .select({ step: schema.routeDecision.step, skipped: schema.routeDecision.skipped })
        .from(schema.routeDecision)
        .where(ofRun(schema.routeDecision, run.runAttempt))
        .limit(1),
      // A retry is the attempt after the one RelayRunner re-ran.
      db
        .select({ id: schema.jobRetry.id })
        .from(schema.jobRetry)
        .where(
          and(ofRun(schema.jobRetry, run.runAttempt - 1), eq(schema.jobRetry.status, "requested")),
        )
        .limit(1),
    ]);
    const span = await runSpan({
      repository,
      run,
      route: decision
        ? {
            provider: decision.step,
            skipped: decision.skipped.map(({ key, reason }) => `${key}: ${reason}`),
          }
        : null,
      retry: !!retried,
    });
    return span ? [span] : [];
  });
}

/** Where OTLP/HTTP traces go for a configured endpoint. */
export function tracesUrl(endpoint: string) {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

export type SendResult = { ok: true } | { ok: false; retry: boolean; error: string };

/** POST spans to an endpoint. 429, 5xx and network errors are worth retrying; other refusals aren't. */
export async function sendSpans(
  row: Pick<ExportRow, "endpoint" | "serviceName">,
  headers: Record<string, string>,
  groups: { resource: Attributes; spans: Span[] }[],
  fetcher: typeof fetch = fetch,
): Promise<SendResult> {
  const body = otlpRequest(
    groups.map(({ resource, spans }) => ({
      resource: { "service.name": row.serviceName, ...resource },
      spans,
    })),
  );
  try {
    const response = await fetcher(tracesUrl(row.endpoint), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
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
 * only failed for FAILING_DAYS turns itself off.
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
      enabled: sql`case when ${stale} then 0 else ${schema.telemetryExport.enabled} end`,
      pausedAt: sql`case when ${stale} then ${now.getTime()} else ${schema.telemetryExport.pausedAt} end`,
    })
    .where(where);
}

/** Handle one batch from the telemetry queue: one request per workspace in it. Never throws. */
export async function handleTelemetryBatch(
  batch: MessageBatch<TelemetryMessage>,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const db = createDb(env.DB);
  const byWorkspace = new Map<string, Message<TelemetryMessage>[]>();
  for (const msg of batch.messages) {
    const list = byWorkspace.get(msg.body.workspaceId) ?? [];
    list.push(msg);
    byWorkspace.set(msg.body.workspaceId, list);
  }
  await Promise.all(
    [...byWorkspace].map(async ([workspaceId, messages]) => {
      try {
        const [row] = await db
          .select()
          .from(schema.telemetryExport)
          .where(eq(schema.telemetryExport.workspaceId, workspaceId))
          .limit(1);
        // Turned off or removed since these were queued.
        if (!row?.enabled) return messages.forEach((msg) => msg.ack());
        const sent = await sendSpans(
          row,
          await openHeaders(env, row),
          messages.map((msg) => msg.body),
          fetcher,
        );
        await recordSend(db, workspaceId, sent);
        for (const msg of messages) {
          if (!sent.ok && sent.retry && msg.attempts < MAX_ATTEMPTS)
            msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
          else msg.ack();
        }
        if (!sent.ok)
          console.warn(
            JSON.stringify({
              msg: "telemetry send failed",
              workspaceId,
              retry: sent.retry,
              error: sent.error,
            }),
          );
      } catch (error) {
        console.warn(
          JSON.stringify({
            msg: "telemetry batch failed",
            workspaceId,
            error: errorMessage(error),
          }),
        );
        for (const msg of messages) msg.retry({ delaySeconds: 60 });
      }
    }),
  );
}
