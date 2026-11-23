// Archiving finished jobs' logs to a workspace's S3-compatible bucket (Settings → Telemetry): S3,
// R2, Google Cloud Storage or anything else that speaks the S3 API. Each job's log becomes one
// gzipped NDJSON object, written with a SigV4-signed PUT. The job log queue (src/telemetry/logs.ts)
// reads the log from GitHub and hands its records here; nothing is kept on the way.
//
// An object's key comes from the repository, the day the job finished, the run and the job, so a
// job's log always lands at the same key and a retry overwrites rather than duplicates it.
import { AwsClient } from "aws4fetch";
import type { schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { openToken } from "../providers/provider-tokens.ts";
import { jobUrl } from "../reports/run-job.ts";
import { errorMessage } from "../errors.ts";
import type { Job, LogRecord } from "./log-lines.ts";
import { gzip, resultOf, type SendResult } from "./otlp.ts";
import type { Repository } from "./spans.ts";

type BucketRow = typeof schema.logBucket.$inferSelect;

// The associated data the credentials are sealed with (src/providers/provider-tokens.ts), so they can't be
// moved onto the telemetry headers or another workspace.
export const CREDENTIALS_PURPOSE = "log-bucket";
const PUT_TIMEOUT_MS = 30_000;

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export function openCredentials(env: Env, row: Pick<BucketRow, "workspaceId" | "credentials">) {
  return openToken(env, row.workspaceId, CREDENTIALS_PURPOSE, row.credentials).then(
    (json) => JSON.parse(json) as Credentials,
  );
}

/**
 * An object's URL. Amazon S3 wants the bucket in the host name (virtual-hosted style), unless the
 * name has a dot, which its certificate doesn't cover; the other services take it as the path's
 * first part.
 */
export function objectUrl(row: Pick<BucketRow, "endpoint" | "bucket">, key: string) {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const { hostname } = new URL(row.endpoint);
  if (/^s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(hostname) && !row.bucket.includes("."))
    return `https://${row.bucket}.${hostname}/${path}`;
  return `${row.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(row.bucket)}/${path}`;
}

/** `{prefix}{owner}/{repo}/{yyyy}/{mm}/{dd}/{run}-{attempt}/{job}.ndjson.gz`, by the day it finished. */
export function objectKey(
  prefix: string,
  repository: Repository,
  job: Pick<Job, "id" | "runId" | "runAttempt" | "completedAt">,
  now = new Date(),
) {
  const at = job.completedAt ? new Date(job.completedAt) : now;
  const day = (Number.isNaN(at.getTime()) ? now : at).toISOString().slice(0, 10).replace(/-/g, "/");
  return `${prefix}${repository.fullName}/${day}/${job.runId}-${job.runAttempt}/${job.id}.ndjson.gz`;
}

/** An OTLP record's time, as RFC 3339 to the nanosecond. */
export function isoTime(timeUnixNano: string) {
  const seconds = Number(timeUnixNano.slice(0, -9) || "0");
  const fraction = timeUnixNano.slice(-9).padStart(9, "0");
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
}

/**
 * A job's log as gzipped NDJSON: a first line about the job, then one line per log line with its
 * time, level, step and text.
 */
export async function ndjson(repository: Repository, job: Job, chunks: AsyncIterable<LogRecord[]>) {
  const compressor = new CompressionStream("gzip");
  const compressed = new Response(compressor.readable).arrayBuffer();
  const writer = compressor.writable.getWriter();
  const encoder = new TextEncoder();
  // One write per chunk of records rather than per line, since a log can have 200,000 lines.
  const write = (values: object[]) =>
    writer.write(encoder.encode(values.map((value) => `${JSON.stringify(value)}\n`).join("")));
  await write([
    {
      type: "job",
      repository: repository.fullName,
      workflow: job.workflowName,
      job: job.name,
      job_id: job.id,
      run_id: job.runId,
      run_attempt: job.runAttempt,
      conclusion: job.conclusion,
      url: jobUrl(repository.fullName, job.runId, job.id),
    },
  ]);
  for await (const chunk of chunks)
    await write(
      chunk.map((record) => ({
        type: "line",
        time: isoTime(record.timeUnixNano),
        level: record.severity,
        step: record.step?.number ?? null,
        step_name: record.step?.name ?? null,
        message: record.body,
      })),
    );
  await writer.close();
  return new Uint8Array(await compressed);
}

/**
 * An S3 error's code and message, leaving out the rest of its XML, which can name the full access
 * key id. Members can read the error in Settings.
 */
export function s3Error(error: string) {
  const code = /<Code>([^<]*)<\/Code>/.exec(error)?.[1];
  const message = /<Message>([^<]*)<\/Message>/.exec(error)?.[1];
  const status = error.split(":")[0]!;
  if (code) return `${status}: ${code}${message ? ` (${message})` : ""}`;
  return error.includes("<") ? status : error;
}

/**
 * PUT an object. 429, 5xx and network errors are worth retrying; other refusals, redirects
 * included, aren't.
 */
export async function putObject(
  row: Pick<BucketRow, "endpoint" | "bucket" | "region">,
  credentials: Credentials,
  key: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<SendResult> {
  const client = new AwsClient({ ...credentials, service: "s3", region: row.region, retries: 0 });
  try {
    const response = await client.fetch(objectUrl(row, key), {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    const sent = await resultOf(response);
    return sent.ok ? sent : { ...sent, error: s3Error(sent.error) };
  } catch (error) {
    return { ok: false, retry: true, error: errorMessage(error) };
  }
}

/** A one-line object for the Settings page's test button, at `{prefix}relayrunner-test.ndjson.gz`. */
export async function testBucket(
  row: Pick<BucketRow, "endpoint" | "bucket" | "region" | "prefix">,
  credentials: Credentials,
  now = new Date(),
) {
  const body = await gzip(`${JSON.stringify({ type: "test", time: now.toISOString() })}\n`);
  return putObject(row, credentials, `${row.prefix}relayrunner-test.ndjson.gz`, body);
}
