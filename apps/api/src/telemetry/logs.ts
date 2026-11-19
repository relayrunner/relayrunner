// Sending finished jobs' logs to a workspace's OTLP endpoint (Settings → Telemetry), for workspaces
// that turn it on: failed jobs only, or every job. A finished job queues a small message here, and
// this queue's consumer reads the job's log from GitHub, turns each line into an OTLP log record and
// POSTs them in gzipped requests of a few hundred KB of log each. Nothing is kept: the log streams
// from GitHub to the endpoint.
//
// Each record carries the trace and span ids of its step's span (src/telemetry/spans.ts), so a tool
// that also gets the traces shows a step's lines with it. GitHub masks registered secrets before it
// stores a log; redactor() also hides anything that looks like a credential (src/feedback.ts) in
// case one was never registered.
import type { WebhookMessage, WorkflowJob } from "@relayrunner/github-webhooks";
import { eq } from "drizzle-orm";
import { createDb, type Db, schema } from "../db/index.ts";
import { redactSecrets } from "../feedback.ts";
import type { Env } from "../env.ts";
import { appInstallationToken, jobLog, type RateLimitBucket, rateLimits } from "../github-app.ts";
import { FAILED_CONCLUSIONS } from "../job-counts.ts";
import { ANSI } from "../job-failures.ts";
import { Recent } from "../recent.ts";
import { jobUrl } from "../run-job.ts";
import { errorMessage, retryDelaySeconds } from "../webhook-queue.ts";
import { type Exporting, openHeaders, otlpUrl, postOtlp, recordSend } from "./otlp.ts";
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
  stepSpanId,
} from "./spans.ts";

export const JOB_LOG_QUEUE = "relayrunner-job-logs";

type Job = Pick<
  WorkflowJob,
  "id" | "runId" | "runAttempt" | "name" | "workflowName" | "conclusion" | "steps"
>;

/** One finished job whose log goes to its workspace's endpoint. */
export interface JobLogMessage {
  workspaceId: string;
  installationId: number;
  repository: Repository;
  job: Job;
  // The first request to send, when an earlier try sent the ones before it.
  from?: number;
  // Tries so far. Counted here, since a try that sent part of the log queues a new message.
  tries?: number;
}

type WorkflowJobMessage = Extract<WebhookMessage, { event: "workflow_job" }>;
type ExportRow = typeof schema.telemetryExport.$inferSelect;

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
// Log text per request, before JSON and gzip. Keeps each request around 1 MB unzipped, under
// every common backend's limit.
const CHUNK_BYTES = 256 * 1024;
const CHUNK_RECORDS = 2_000;
// A job sends at most its first HEAD_BYTES and last TAIL_BYTES of log, with a line saying how much
// was left out between: a failed job's error is at the end.
export const HEAD_BYTES = 16 * 1024 * 1024;
export const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 16 * 1024;

/** Whether a finished job's log goes out under a workspace's setting. */
export function sendsLog(logs: ExportRow["logs"], job: WorkflowJob) {
  if (logs === "off" || !job.startedAt) return false;
  return logs === "all" || FAILED_CONCLUSIONS.includes(job.conclusion ?? "");
}

/** Queue a finished job's log, when its workspace sends logs for it. Never throws. */
export async function queueJobLog(env: Env, exporting: Exporting, message: WorkflowJobMessage) {
  const { job, repository, installationId } = message;
  if (!installationId || !sendsLog(exporting.logs, job)) return;
  try {
    const { id, runId, runAttempt, name, workflowName, conclusion, steps } = job;
    await env.JOB_LOG_QUEUE.send(
      {
        workspaceId: exporting.workspaceId,
        installationId,
        repository: { id: repository.id, fullName: repository.fullName },
        job: { id, runId, runAttempt, name, workflowName, conclusion, steps },
      },
      { delaySeconds: FIRST_DELAY_SECONDS },
    );
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

// The timestamp GitHub starts each line with.
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z ?/;

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * Hides what looks like a credential in each log line, as feedback does, and the lines of a private
 * key between its BEGIN and END lines, which feedback's patterns only see whole. Keeps state across
 * lines, so use one per log.
 */
export function redactor() {
  let inKey = false;
  return (line: string) => {
    if (inKey) {
      if (PEM_END.test(line)) inKey = false;
      else return "[redacted]";
    } else if (PEM_BEGIN.test(line) && !PEM_END.test(line)) inKey = true;
    return redactSecrets(line).text;
  };
}

export interface LogRecord {
  // Nanoseconds since the epoch, as OTLP JSON wants: a string.
  timeUnixNano: string;
  severity: Severity;
  body: string;
  // The step the line belongs to, with its span id; null before the first step or with no steps.
  step: Step | null;
}

const SEVERITIES = {
  debug: { number: 5, text: "DEBUG" },
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  error: { number: 17, text: "ERROR" },
} as const;
type Severity = keyof typeof SEVERITIES;

function severityOf(line: string): Severity {
  if (line.startsWith("##[error]")) return "error";
  if (line.startsWith("##[warning]")) return "warn";
  if (line.startsWith("##[debug]")) return "debug";
  return "info";
}

/** A line's time in nanoseconds and milliseconds, or null when it has no timestamp. */
export function lineTime(line: string): { nanos: string; ms: number; rest: string } | null {
  const match = TIMESTAMP.exec(line);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(seconds)) return null;
  const fraction = (match[2] ?? "").padEnd(9, "0");
  return {
    nanos: `${seconds / 1000}${fraction}`,
    ms: seconds + Number(fraction.slice(0, 3)),
    rest: line.slice(match[0].length),
  };
}

interface Step {
  number: number;
  name: string;
  spanId: string;
  start: number;
}

/** The job's steps that ran, by start time, with their span ids. */
async function stepsOf(job: Job): Promise<Step[]> {
  const steps = await Promise.all(
    (job.steps ?? []).map(async (step) => {
      const start = step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
      if (Number.isNaN(start) || step.conclusion === "skipped") return null;
      return {
        number: step.number,
        name: step.name,
        start,
        spanId: await stepSpanId(job.id, step.number),
      };
    }),
  );
  return steps.filter((step) => step !== null).sort((a, b) => a.start - b.start);
}

/**
 * Turns a log, line by line, into records. GitHub gives step times to the second, so a line belongs
 * to the last step that started in or before its second.
 */
export async function logRecords(job: Job) {
  const steps = await stepsOf(job);
  const redact = redactor();
  let time = { nanos: "0", ms: 0 };
  // Lines come in time order, so the step only moves forward; `next` is the first not yet started.
  let next = 0;
  return (line: string): LogRecord => {
    const parsed = lineTime(line);
    if (parsed) time = parsed;
    const text = redact((parsed ? parsed.rest : line).replace(ANSI, "")).slice(0, MAX_LINE_CHARS);
    const second = Math.floor(time.ms / 1000) * 1000;
    while (next < steps.length && steps[next]!.start <= second) next++;
    return {
      timeUnixNano: time.nanos,
      severity: severityOf(text),
      body: text,
      step: steps[next - 1] ?? null,
    };
  };
}

/** Splits a byte stream into lines, without their line endings. */
export async function* lines(stream: ReadableStream<Uint8Array>) {
  let rest = "";
  for await (const text of stream.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + text).split(/\r?\n/);
    rest = parts.pop()!;
    yield* parts;
  }
  if (rest) yield rest;
}

/**
 * A log's records in requests of about CHUNK_BYTES of text: its first HEAD_BYTES, then a line
 * saying how much was left out, then its last TAIL_BYTES. Lines past the head are only turned into
 * records once they're known to be in the tail.
 */
export async function* chunks(
  source: AsyncIterable<string>,
  toRecord: (line: string) => LogRecord,
  jobUrl: string,
) {
  let chunk: LogRecord[] = [];
  let chunkBytes = 0;
  function* add(record: LogRecord) {
    chunk.push(record);
    chunkBytes += record.body.length + 1;
    if (chunkBytes >= CHUNK_BYTES || chunk.length >= CHUNK_RECORDS) {
      yield chunk;
      chunk = [];
      chunkBytes = 0;
    }
  }
  let total = 0;
  // The tail is tail[start..], so dropping its oldest line doesn't move the rest.
  let tail: string[] = [];
  let start = 0;
  let tailBytes = 0;
  let cutLines = 0;
  let cutBytes = 0;
  for await (const line of source) {
    const size = line.length + 1;
    total += size;
    if (total <= HEAD_BYTES) {
      yield* add(toRecord(line));
      continue;
    }
    tail.push(line);
    tailBytes += size;
    while (tailBytes > TAIL_BYTES) {
      const dropped = tail[start++]!.length + 1;
      tailBytes -= dropped;
      cutLines++;
      cutBytes += dropped;
    }
    if (start > 100_000) {
      tail = tail.slice(start);
      start = 0;
    }
  }
  const kept = tail.slice(start).map(toRecord);
  if (cutLines && kept.length) {
    const mb = Math.max(1, Math.round(cutBytes / (1024 * 1024)));
    yield* add({
      ...kept[0]!,
      severity: "warn",
      body: `${cutLines.toLocaleString("en-US")} lines (${mb} MB) left out here to keep this log to 20 MB. The full log is on GitHub: ${jobUrl}`,
    });
  }
  for (const record of kept) yield* add(record);
  if (chunk.length) yield chunk;
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

async function gzip(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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

/** Read one job's log from GitHub and send it, from request `from` on. */
async function sendJobLog(
  env: Env,
  db: Db,
  row: ExportRow,
  body: JobLogMessage,
  tries: number,
): Promise<Outcome> {
  const { repository, job } = body;
  const from = body.from ?? 0;
  const token = await appInstallationToken(env, body.installationId);
  const wait = await waitForCalls(token, body.installationId);
  if (wait) {
    if (tries >= MAX_TRIES) return { skipped: "GitHub's API limit for the App was nearly used up" };
    return { done: false, from, delaySeconds: Math.min(wait, 15 * 60) };
  }
  const log = await jobLog(token, repository.fullName, job.id);
  if (!log) {
    if (tries >= NOT_FOUND_TRIES) return { skipped: "GitHub doesn't have the job's log" };
    return { done: false, from, delaySeconds: 60 };
  }
  const url = otlpUrl(row.endpoint, "logs");
  const resource = jobResource(row, repository, job);
  const [headers, { traceId }, jobSpan, records] = await Promise.all([
    openHeaders(env, row),
    runIds(repository.id, job.runId, job.runAttempt),
    jobSpanId(job.id),
    logRecords(job),
  ]);
  const trace = { traceId, jobSpanId: jobSpan };
  let index = 0;
  let sent = false;
  try {
    for await (const chunk of chunks(
      lines(log),
      records,
      jobUrl(repository.fullName, job.runId, job.id),
    )) {
      if (index >= from) {
        const request = logsRequest(resource, chunk, trace);
        const result = await postOtlp(url, headers, await gzip(JSON.stringify(request)));
        if (!result.ok) {
          await recordSend(db, row.workspaceId, result);
          console.warn(
            JSON.stringify({
              msg: "job log send failed",
              workspaceId: row.workspaceId,
              retry: result.retry,
              error: result.error,
            }),
          );
          if (!result.retry || tries >= MAX_TRIES)
            return { skipped: `Your endpoint refused it: ${result.error}` };
          return { done: false, from: index, delaySeconds: retryDelaySeconds(tries) };
        }
        sent = true;
      }
      index++;
    }
  } finally {
    await log.cancel().catch(() => {});
  }
  if (sent) await recordSend(db, row.workspaceId, { ok: true });
  return { done: true };
}

async function recordSkip(db: Db, workspaceId: string, reason: string, now = new Date()) {
  await db
    .update(schema.telemetryExport)
    .set({ logsSkipped: reason, logsSkippedAt: now })
    .where(eq(schema.telemetryExport.workspaceId, workspaceId));
}

/** Handle one batch from the job log queue, each job on its own. Never throws. */
export async function handleJobLogBatch(batch: MessageBatch<JobLogMessage>, env: Env) {
  const db = createDb(env.DB);
  await Promise.all(
    batch.messages.map(async (msg) => {
      const body = msg.body;
      const tries = (body.tries ?? 0) + 1;
      try {
        const [row] = await db
          .select()
          .from(schema.telemetryExport)
          .where(eq(schema.telemetryExport.workspaceId, body.workspaceId))
          .limit(1);
        // Turned off, paused or removed since it was queued.
        if (!row || row.pausedAt || row.logs === "off") return msg.ack();
        const outcome = await sendJobLog(env, db, row, body, tries);
        if ("skipped" in outcome) await recordSkip(db, row.workspaceId, outcome.skipped);
        else if (!outcome.done)
          await env.JOB_LOG_QUEUE.send(
            { ...body, from: outcome.from, tries },
            { delaySeconds: outcome.delaySeconds },
          );
        msg.ack();
      } catch (error) {
        console.warn(
          JSON.stringify({
            msg: "job log failed",
            workspaceId: body.workspaceId,
            jobId: body.job.id,
            error: errorMessage(error),
          }),
        );
        if (tries >= MAX_TRIES) return msg.ack();
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
