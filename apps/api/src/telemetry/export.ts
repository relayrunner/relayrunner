// Sending CI traces to a workspace's OTLP endpoint (Settings → Telemetry). The webhook consumer
// turns each finished job and run into spans (src/telemetry/spans.ts) and queues them here, only
// for workspaces with an export on. This queue's consumer batches them per workspace and POSTs one
// OTLP/HTTP JSON request each. Spans are telemetry, not records: ones that run out of retries are
// dropped, and the run is still in History.
import { retryDelaySeconds } from "../queue-retry.ts";
import { environmentFor, environmentProvider, nameMachines } from "../reports/environments.ts";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { and, eq } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { queueJobLog } from "./logs.ts";
import {
  type Exporting,
  exportingFor,
  openHeaders,
  otlpUrl,
  postOtlp,
  recordSend,
} from "./otlp.ts";
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

// The consumer's max_retries in wrangler.jsonc. With retryDelaySeconds that's about an hour.
const MAX_ATTEMPTS = 8;

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;
type WorkflowRunMessage = Extract<WebhookMessage, { event: "workflow_run" }>;
type ExportRow = typeof schema.telemetryExport.$inferSelect;

/**
 * Queue one job's or run's spans, when its installation's workspace exports traces. Never throws:
 * a retried webhook would redo everything else for it.
 */
async function queueSpans(
  env: Env,
  exporting: Exporting | undefined,
  repository: Repository,
  spansFor: (workspaceId: string) => Promise<Span[]>,
) {
  if (!exporting?.traces) return;
  try {
    const spans = await spansFor(exporting.workspaceId);
    if (spans.length)
      await env.TELEMETRY_QUEUE.send({
        workspaceId: exporting.workspaceId,
        resource: repositoryResource(repository),
        spans,
      });
  } catch (error) {
    console.warn(JSON.stringify({ msg: "couldn't queue spans", error: errorMessage(error) }));
  }
}

/**
 * Queue a finished job's spans and its log, when its workspace exports them. Never throws: a
 * retried webhook would redo everything else for it.
 */
export async function exportJob(env: Env, db: Db, message: WorkflowJobMessage) {
  if (message.job.status !== "completed") return;
  const exporting = await exportingFor(db, message.installationId);
  if (!exporting) return;
  await Promise.all([
    queueJobLog(env, exporting, message),
    queueJobSpans(env, db, exporting, message),
  ]);
}

function queueJobSpans(env: Env, db: Db, exporting: Exporting, message: WorkflowJobMessage) {
  const { job, repository } = message;
  return queueSpans(env, exporting, repository, async (workspaceId) => {
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
  const exporting = await exportingFor(db, message.installationId);
  await queueSpans(env, exporting, repository, async () => {
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
        // An attempt with several relays has a decision per relay: the run's span takes the first.
        .orderBy(schema.routeDecision.id)
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

/** POST spans to an endpoint. */
export function sendSpans(
  row: Pick<ExportRow, "endpoint" | "serviceName">,
  headers: Record<string, string>,
  groups: { resource: Attributes; spans: Span[] }[],
  fetcher: typeof fetch = fetch,
): ReturnType<typeof postOtlp> {
  const body = otlpRequest(
    groups.map(({ resource, spans }) => ({
      resource: { "service.name": row.serviceName, ...resource },
      spans,
    })),
  );
  return postOtlp(otlpUrl(row.endpoint, "traces"), headers, JSON.stringify(body), fetcher);
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
        // Turned off, paused or removed since these were queued.
        if (!row?.enabled || row.pausedAt) return messages.forEach((msg) => msg.ack());
        const sent = await sendSpans(
          row,
          await openHeaders(env, row),
          messages.map((msg) => msg.body),
          fetcher,
        );
        await recordSend(db, workspaceId, sent, schema.telemetryExport);
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
