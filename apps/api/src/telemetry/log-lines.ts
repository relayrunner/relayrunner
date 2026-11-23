// A job's log, line by line, as records: each line's time, severity and step, with what looks
// like a credential hidden, and a cap on how much of a long log is kept. Log export
// (src/telemetry/logs.ts) sends them to an OTLP endpoint and src/telemetry/bucket.ts writes them to
// a bucket.
import type { WorkflowJob } from "@relayrunner/github-webhooks";
import { redactSecrets } from "../operator/feedback.ts";
import { ANSI } from "../reports/job-failures.ts";
import { stepSpanId } from "./spans.ts";

export type Job = Pick<
  WorkflowJob,
  "id" | "runId" | "runAttempt" | "name" | "workflowName" | "conclusion" | "steps" | "completedAt"
>;
// Log text per request, before JSON and gzip. Keeps each request around 1 MB unzipped, under
// every common backend's limit.
const CHUNK_BYTES = 256 * 1024;
const CHUNK_RECORDS = 2_000;
// A job sends at most its first HEAD_BYTES and last TAIL_BYTES of log, with a line saying how much
// was left out between: a failed job's error is at the end.
export const HEAD_BYTES = 16 * 1024 * 1024;
export const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 16 * 1024;

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

export const SEVERITIES = {
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
