// Sending CI traces to a workspace's OTLP endpoint (Settings → Telemetry). The webhook consumer
// turns each finished job and run into spans (src/telemetry/spans.ts) and queues them here, only
// for workspaces with an export on. This queue's consumer batches them per workspace and POSTs one
// OTLP/HTTP JSON request each. Spans are telemetry, not records: ones that run out of retries are
// dropped, and the run is still in History.
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq, sql } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { environmentFor, nameMachines } from "../job-times.ts";
import { openToken } from "../provider-tokens.ts";
import { errorMessage } from "../webhook-queue.ts";
import {
  type Attributes,
  jobSpans,
  otlpRequest,
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
// The consumer's max_retries in wrangler.jsonc. With RETRY_DELAYS that's about an hour.
const MAX_ATTEMPTS = 8;
const RETRY_DELAYS = [30, 60, 120, 240, 480, 900];
// An export that has only failed for this long turns itself off, so a revoked key doesn't keep
// costing a request per batch forever.
export const FAILING_DAYS = 3;
const DAY_MS = 86_400_000;
const SEND_TIMEOUT_MS = 10_000;

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;
type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;
type ExportRow = typeof schema.telemetryExport.$inferSelect;

/** The workspace an installation's spans go to, when it has an export on. */
async function exportingWorkspace(db: Db, installationId: number | null) {
  if (!installationId) return null;
  const [row] = await db
    .select({ workspaceId: schema.telemetryExport.workspaceId })
    .from(schema.telemetryExport)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.telemetryExport.workspaceId))
    .where(
      and(
        eq(schema.workspace.installationId, installationId),
        eq(schema.telemetryExport.enabled, true),
      ),
    )
    .limit(1);
  return row?.workspaceId ?? null;
}

// Telemetry never fails the webhook: a retried delivery would redo everything else for it.
async function quietly(what: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    console.warn(
      JSON.stringify({ msg: `couldn't queue ${what} spans`, error: errorMessage(error) }),
    );
  }
}

/** Queue a finished job's spans, when its workspace exports traces. */
export function exportJob(env: Env, db: Db, message: WorkflowJobMessage) {
  const { job, repository } = message;
  if (job.status !== "completed") return;
  return quietly("job", async () => {
    const workspaceId = await exportingWorkspace(db, message.installationId);
    if (!workspaceId) return;
    const [timing] = await db
      .select({ machineId: schema.jobTiming.machineId, usage: schema.jobTiming.usage })
      .from(schema.jobTiming)
      .where(eq(schema.jobTiming.id, job.id))
      .limit(1);
    let ranOn: { provider: string; runner: string } | null = null;
    if (job.startedAt) {
      const env = environmentFor(
        job.labels,
        job.runnerGroupName ?? null,
        timing?.machineId ?? null,
      );
      await nameMachines(db, workspaceId, new Map([[env.key, env]]));
      ranOn = { provider: env.key.split(":")[0]!, runner: env.label };
    }
    const spans = await jobSpans({ repository, job, ranOn, usage: timing?.usage ?? null });
    if (spans.length)
      await env.TELEMETRY_QUEUE.send({
        workspaceId,
        resource: repositoryResource(repository),
        spans,
      });
  });
}

/** Queue a finished run's root span, when its workspace exports traces. */
export function exportRun(env: Env, db: Db, message: WorkflowRunMessage) {
  const { run, repository } = message;
  if (run.status !== "completed") return;
  return quietly("run", async () => {
    const workspaceId = await exportingWorkspace(db, message.installationId);
    if (!workspaceId) return;
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
    if (span)
      await env.TELEMETRY_QUEUE.send({
        workspaceId,
        resource: repositoryResource(repository),
        spans: [span],
      });
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
    await db
      .update(schema.telemetryExport)
      .set({ lastSentAt: now, error: null, failingSince: null })
      .where(where);
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
            msg.retry({
              delaySeconds: RETRY_DELAYS[Math.min(msg.attempts - 1, RETRY_DELAYS.length - 1)],
            });
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
