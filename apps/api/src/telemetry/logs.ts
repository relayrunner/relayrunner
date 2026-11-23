// Sending finished jobs' logs out, for workspaces that turn it on (Settings → Telemetry): to their
// OTLP endpoint, to their S3-compatible bucket (src/telemetry/bucket.ts), or both, each for failed
// jobs only or every job. A finished job queues a small message here per destination, and this
// queue's consumer reads the job's log from GitHub and sends it on. Nothing is kept: the log
// streams from GitHub to where it goes.
//
// To an OTLP endpoint, each line is a log record in gzipped requests of a few hundred KB of log
// each, carrying the trace and span ids of its step's span (src/telemetry/spans.ts), so a tool that
// also gets the traces shows a step's lines with it.
import { retryDelaySeconds } from "../queue-retry.ts";
import type { WebhookMessage, WorkflowJob } from "@relayrunner/github-webhooks";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { jobLog } from "../github/actions-api.ts";
import { appInstallationToken, type RateLimitBucket, rateLimits } from "../github/github-app.ts";
import { FAILED_CONCLUSIONS } from "../ingest/job-counts.ts";
import { Recent } from "../recent.ts";
import { jobUrl } from "../reports/run-job.ts";
import { errorMessage } from "../errors.ts";
import { ndjson, objectKey, openCredentials, putObject } from "./bucket.ts";
import { chunks, type Job, lines, type LogRecord, logRecords, SEVERITIES } from "./log-lines.ts";
import {
  bucketRow,
  exportRow,
  type Exporting,
  gzip,
  openHeaders,
  otlpUrl,
  postOtlp,
  recordSend,
  recordSkip,
  type SendResult,
} from "./otlp.ts";
import {
  type Attributes,
  encodeAttributes,
  jobAttributes,
  jobSpanId,
  nanos,
  type Repository,
  repositoryResource,
  runIds,
  SCOPE,
} from "./spans.ts";

export const JOB_LOG_QUEUE = "relayrunner-job-logs";

/** One finished job whose log goes to its workspace's OTLP endpoint or bucket. */
export interface JobLogMessage {
  workspaceId: string;
  installationId: number;
  repository: Repository;
  job: Job;
  // "bucket" for the workspace's bucket; unset for its OTLP endpoint.
  to?: "bucket";
  // The first request to send, when an earlier try sent the ones before it.
  from?: number;
  // Tries so far. Counted here, since a try that sent part of the log queues a new message.
  tries?: number;
}

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;
type ExportRow = typeof schema.telemetryExport.$inferSelect;
type BucketRow = typeof schema.logBucket.$inferSelect;

// GitHub can answer 404 for a few seconds after a job finishes, so the read waits a little.
const FIRST_DELAY_SECONDS = 30;
// Tries for one job, about an hour with retryDelaySeconds. A log GitHub still doesn't have after
// NOT_FOUND_TRIES is gone (or never existed, when the runner failed before any step).
const MAX_TRIES = 8;
const NOT_FOUND_TRIES = 3;
// Of the installation's hourly API calls, the share log reads leave for routing and the dashboard.
// Higher than the 10% failure reads in History keep, since these are background work.
const RESERVE = 0.25;
const LIMITS_MS = 30_000;

/** Whether a finished job's log goes out under a setting. */
export function sendsLog(logs: ExportRow["logs"], job: WorkflowJob) {
  if (logs === "off" || !job.startedAt) return false;
  return logs === "all" || FAILED_CONCLUSIONS.includes(job.conclusion ?? "");
}

/** Queue a finished job's log once for each place its workspace sends it. Never throws. */
export async function queueJobLog(env: Env, exporting: Exporting, message: WorkflowJobMessage) {
  const { job, repository, installationId } = message;
  if (!installationId) return;
  const { id, runId, runAttempt, name, workflowName, conclusion, steps, completedAt } = job;
  const body: JobLogMessage = {
    workspaceId: exporting.workspaceId,
    installationId,
    repository: { id: repository.id, fullName: repository.fullName },
    job: { id, runId, runAttempt, name, workflowName, conclusion, steps, completedAt },
  };
  const messages = [
    ...(sendsLog(exporting.logs, job) ? [{ body }] : []),
    ...(sendsLog(exporting.bucket, job) ? [{ body: { ...body, to: "bucket" as const } }] : []),
  ];
  if (!messages.length) return;
  try {
    await env.JOB_LOG_QUEUE.sendBatch(messages, { delaySeconds: FIRST_DELAY_SECONDS });
  } catch (error) {
    console.warn(JSON.stringify({ msg: "couldn't queue a job log", error: errorMessage(error) }));
  }
}

// Each installation's API calls left, read at most every LIMITS_MS per isolate (GitHub doesn't
// count calls to /rate_limit, but there's one per job otherwise).
const limits = new Recent<number, RateLimitBucket | null>(1_000);

/** Forgets the rate limits read above, for tests. */
export function forgetRateLimits() {
  limits.clear();
}

/** Seconds to wait before reading a log, or 0 when the installation has calls to spare. */
async function waitForCalls(token: string, installationId: number, now = Date.now()) {
  const core = await limits.get(
    installationId,
    LIMITS_MS,
    async () => (await rateLimits(token)).core,
  );
  if (!core || core.remaining >= core.limit * RESERVE) return 0;
  return Math.max(60, Math.ceil((core.reset.getTime() - now) / 1000));
}

/**
 * The OTLP export request for some records. With `trace`, each record joins its step's span, or the
 * job's when it came before the first step.
 */
export function logsRequest(
  resource: Attributes,
  records: LogRecord[],
  trace?: { traceId: string; jobSpanId: string },
) {
  return {
    resourceLogs: [
      {
        resource: { attributes: encodeAttributes(resource) },
        scopeLogs: [
          {
            scope: SCOPE,
            logRecords: records.map((record) => ({
              timeUnixNano: record.timeUnixNano,
              severityNumber: SEVERITIES[record.severity].number,
              severityText: SEVERITIES[record.severity].text,
              body: { stringValue: record.body },
              attributes: encodeAttributes({
                "relayrunner.step.number": record.step?.number,
                "relayrunner.step.name": record.step?.name,
              }),
              ...(trace && {
                traceId: trace.traceId,
                spanId: record.step?.spanId ?? trace.jobSpanId,
              }),
            })),
          },
        ],
      },
    ],
  };
}

/** The resource for one job's records: its repository and the job, as on its span. */
function jobResource(row: Pick<ExportRow, "serviceName">, repository: Repository, job: Job) {
  return {
    "service.name": row.serviceName,
    ...repositoryResource(repository),
    ...jobAttributes(repository, job),
    "relayrunner.run.attempt": job.runAttempt,
    "relayrunner.job.conclusion": job.conclusion,
  };
}

type Outcome =
  | { done: true }
  | { done: false; from: number; delaySeconds: number }
  | { skipped: string };

/** A finished send's outcome: done, worth another try from request `from`, or given up on. */
function afterSend(sent: SendResult, from: number, tries: number): Outcome {
  if (sent.ok) return { done: true };
  if (!sent.retry || tries >= MAX_TRIES) return { skipped: `It was refused: ${sent.error}` };
  return { done: false, from, delaySeconds: retryDelaySeconds(tries) };
}

/** Read one job's log from GitHub and hand it to `send`, or say why not yet. */
async function withLog(
  env: Env,
  body: JobLogMessage,
  tries: number,
  send: (log: ReadableStream<Uint8Array>) => Promise<Outcome>,
): Promise<Outcome> {
  const from = body.from ?? 0;
  const token = await appInstallationToken(env, body.installationId);
  const wait = await waitForCalls(token, body.installationId);
  if (wait) {
    if (tries >= MAX_TRIES) return { skipped: "GitHub's API limit for the App was nearly used up" };
    return { done: false, from, delaySeconds: Math.min(wait, 15 * 60) };
  }
  const log = await jobLog(token, body.repository.fullName, body.job.id);
  if (!log) {
    if (tries >= NOT_FOUND_TRIES) return { skipped: "GitHub doesn't have the job's log" };
    return { done: false, from, delaySeconds: 60 };
  }
  try {
    return await send(log);
  } finally {
    await log.cancel().catch(() => {});
  }
}

/** A log's records, read from GitHub's stream, in requests. */
async function recordChunks(body: JobLogMessage, log: ReadableStream<Uint8Array>) {
  const { repository, job } = body;
  return chunks(lines(log), await logRecords(job), jobUrl(repository.fullName, job.runId, job.id));
}

/** Send a job's log to the OTLP endpoint, from request `from` on. */
async function toEndpoint(
  env: Env,
  db: Db,
  row: ExportRow,
  body: JobLogMessage,
  log: ReadableStream<Uint8Array>,
  tries: number,
): Promise<Outcome> {
  const { repository, job } = body;
  const from = body.from ?? 0;
  const url = otlpUrl(row.endpoint, "logs");
  const resource = jobResource(row, repository, job);
  const [headers, { traceId }, jobSpan, records] = await Promise.all([
    openHeaders(env, row),
    runIds(repository.id, job.runId, job.runAttempt),
    jobSpanId(job.id),
    recordChunks(body, log),
  ]);
  const trace = { traceId, jobSpanId: jobSpan };
  let index = 0;
  let sent: SendResult | null = null;
  for await (const chunk of records) {
    if (index >= from) {
      const request = logsRequest(resource, chunk, trace);
      sent = await postOtlp(url, headers, await gzip(JSON.stringify(request)));
      if (!sent.ok) break;
    }
    index++;
  }
  if (sent) await recordSend(db, row.workspaceId, sent, schema.telemetryExport);
  return sent ? afterSend(sent, index, tries) : { done: true };
}

/** Write a job's log to the bucket as one object. */
async function toBucket(
  env: Env,
  db: Db,
  row: BucketRow,
  body: JobLogMessage,
  log: ReadableStream<Uint8Array>,
  tries: number,
): Promise<Outcome> {
  const { repository, job } = body;
  const [credentials, records] = await Promise.all([
    openCredentials(env, row),
    recordChunks(body, log),
  ]);
  const object = await ndjson(repository, job, records);
  const sent = await putObject(row, credentials, objectKey(row.prefix, repository, job), object);
  await recordSend(db, row.workspaceId, sent, schema.logBucket);
  return afterSend(sent, 0, tries);
}

/** Send a message's log to its destination, unless that no longer takes logs. */
async function deliver(env: Env, db: Db, body: JobLogMessage, tries: number) {
  // Turned off, paused or removed since it was queued.
  const takesLogs = (row?: { pausedAt: Date | null; logs: string }) =>
    !!row && !row.pausedAt && row.logs !== "off";
  let table;
  let outcome: Outcome;
  if (body.to === "bucket") {
    const row = await bucketRow(db, body.workspaceId);
    if (!takesLogs(row)) return;
    table = schema.logBucket;
    outcome = await withLog(env, body, tries, (log) => toBucket(env, db, row!, body, log, tries));
  } else {
    const row = await exportRow(db, body.workspaceId);
    if (!takesLogs(row)) return;
    table = schema.telemetryExport;
    outcome = await withLog(env, body, tries, (log) => toEndpoint(env, db, row!, body, log, tries));
  }
  if ("skipped" in outcome) await recordSkip(db, body.workspaceId, outcome.skipped, table);
  else if (!outcome.done)
    await env.JOB_LOG_QUEUE.send(
      { ...body, from: outcome.from, tries },
      { delaySeconds: outcome.delaySeconds },
    );
}

/** Handle one batch from the job log queue, each job on its own. Never throws. */
export async function handleJobLogBatch(batch: MessageBatch<JobLogMessage>, env: Env) {
  const db = createDb(env.DB);
  await Promise.all(
    batch.messages.map(async (msg) => {
      const body = msg.body;
      const tries = (body.tries ?? 0) + 1;
      try {
        await deliver(env, db, body, tries);
        msg.ack();
      } catch (error) {
        console.warn(
          JSON.stringify({
            msg: "job log failed",
            workspaceId: body.workspaceId,
            to: body.to ?? "otlp",
            jobId: body.job.id,
            error: errorMessage(error),
          }),
        );
        if (tries >= MAX_TRIES) {
          // Say so in Settings, which would otherwise look healthy.
          const table = body.to === "bucket" ? schema.logBucket : schema.telemetryExport;
          await recordSkip(db, body.workspaceId, `It failed: ${errorMessage(error)}`, table).catch(
            () => {},
          );
          return msg.ack();
        }
        // A resend keeps the count; the queue's own retry wouldn't.
        await env.JOB_LOG_QUEUE.send({ ...body, tries }, { delaySeconds: retryDelaySeconds(tries) })
          .then(() => msg.ack())
          .catch(() => msg.retry({ delaySeconds: 60 }));
      }
    }),
  );
}

/** A one-line log for the Settings page's test button. */
export function testLogs(
  row: Pick<ExportRow, "endpoint" | "serviceName">,
  headers: Record<string, string>,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const request = logsRequest({ "service.name": row.serviceName, "relayrunner.test": true }, [
    { timeUnixNano: nanos(now), severity: "info", body: "RelayRunner test log", step: null },
  ]);
  return postOtlp(otlpUrl(row.endpoint, "logs"), headers, JSON.stringify(request), fetcher);
}
