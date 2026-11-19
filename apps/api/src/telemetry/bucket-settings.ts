// Settings → Telemetry → Bucket: where a workspace archives its job logs. The access key goes in
// encrypted with the secret (src/provider-tokens.ts) and never comes back out; the dashboard sees the
// access key id's last four characters, and leaves the secret blank to keep the saved one.
import type { JobLogChoice } from "@relayrunner/activity";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { sealToken, tokenHint } from "../provider-tokens.ts";
import { CREDENTIALS_PURPOSE, openCredentials, testBucket } from "./bucket.ts";
import {
  bucketRow,
  exportingInstallations,
  type ExportStatusView,
  NO_STATUS,
  recordSend,
  RESET_STATUS,
  type SendResult,
  statusView,
} from "./otlp.ts";
import { endpointProblem } from "./settings.ts";

export interface BucketView extends ExportStatusView {
  configured: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  keyHint: string;
}

type Row = typeof schema.logBucket.$inferSelect;

const NOT_CONFIGURED: BucketView = {
  ...NO_STATUS,
  configured: false,
  endpoint: "",
  bucket: "",
  region: "",
  prefix: "",
  keyHint: "",
};

function present(row: Row | undefined): BucketView {
  if (!row) return NOT_CONFIGURED;
  return {
    ...statusView(row),
    configured: true,
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region,
    prefix: row.prefix,
    keyHint: row.keyHint,
  };
}

const load = bucketRow;

export async function bucketView(db: Db, workspaceId: string) {
  return present(await load(db, workspaceId));
}

// S3's bucket naming rules, which R2 and Google Cloud Storage also accept.
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,50}$/;

/** Why the settings can't be used, or null when they can. */
export function bucketProblem(input: Pick<BucketInput, "endpoint" | "bucket" | "region">) {
  const endpoint = endpointProblem(input.endpoint, "in the access key fields");
  if (endpoint) return endpoint;
  if (!BUCKET_NAME.test(input.bucket) || input.bucket.includes(".."))
    return "Bucket names are 3 to 63 lowercase letters, numbers, dots and dashes";
  if (!REGION.test(input.region)) return "Enter the bucket's region, or auto";
  return null;
}

/** A prefix as keys use it: no leading slash, and ending in one unless it's empty. */
export function normalizePrefix(prefix: string) {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

export interface BucketInput {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  // Both left out, the saved key stays; a new access key id needs its secret.
  accessKeyId?: string;
  secretAccessKey?: string;
  logs: JobLogChoice;
}

export type BucketSaveResult =
  // `previousLogs`: the logs choice before this save, for Activity.
  | { ok: true; bucket: BucketView; previousLogs: JobLogChoice }
  | { ok: false; error: "BUCKET_INVALID" | "BUCKET_SECRET_MISSING"; message: string };

/**
 * Save (or replace) the workspace's bucket, from trimmed input (the route's schema trims it). Throws
 * TokenKeyError when the key can't be sealed.
 */
export async function saveBucket(
  env: Env,
  db: Db,
  workspaceId: string,
  userId: string,
  input: BucketInput,
): Promise<BucketSaveResult> {
  const endpoint = input.endpoint.replace(/\/+$/, "");
  const bucket = input.bucket;
  const region = input.region.toLowerCase() || "auto";
  const problem = bucketProblem({ endpoint, bucket, region });
  if (problem) return { ok: false, error: "BUCKET_INVALID", message: problem };
  const existing = await load(db, workspaceId);
  const saved = existing ? await openCredentials(env, existing) : null;
  const accessKeyId = input.accessKeyId || saved?.accessKeyId;
  const secretAccessKey =
    input.secretAccessKey ||
    (saved?.accessKeyId === accessKeyId ? saved?.secretAccessKey : undefined);
  if (!accessKeyId)
    return { ok: false, error: "BUCKET_INVALID", message: "Enter the access key ID." };
  if (!secretAccessKey)
    return { ok: false, error: "BUCKET_SECRET_MISSING", message: "Enter the secret access key." };
  const values = {
    endpoint,
    bucket,
    region,
    prefix: normalizePrefix(input.prefix),
    credentials: await sealToken(
      env,
      workspaceId,
      CREDENTIALS_PURPOSE,
      JSON.stringify({ accessKeyId, secretAccessKey }),
    ),
    keyHint: tokenHint(accessKeyId),
    logs: input.logs,
    ...RESET_STATUS,
  };
  await db
    .insert(schema.logBucket)
    .values({ workspaceId, createdBy: userId, ...values })
    .onConflictDoUpdate({ target: schema.logBucket.workspaceId, set: values });
  exportingInstallations.forget();
  return {
    ok: true,
    bucket: await bucketView(db, workspaceId),
    previousLogs: existing?.logs ?? "off",
  };
}

/** Remove the workspace's bucket. Answers the logs choice it had, for Activity. */
export async function deleteBucket(db: Db, workspaceId: string) {
  const [removed] = await db
    .delete(schema.logBucket)
    .where(eq(schema.logBucket.workspaceId, workspaceId))
    .returning({ logs: schema.logBucket.logs });
  exportingInstallations.forget();
  return { bucket: NOT_CONFIGURED, previousLogs: removed?.logs ?? "off" };
}

/** Write a small test object with the saved settings, and record how it went. Null when unset. */
export async function testBucketSettings(
  env: Env,
  db: Db,
  workspaceId: string,
): Promise<{ sent: SendResult; bucket: BucketView } | null> {
  const row = await load(db, workspaceId);
  if (!row) return null;
  const sent = await testBucket(row, await openCredentials(env, row));
  await recordSend(db, workspaceId, sent, schema.logBucket);
  return { sent, bucket: await bucketView(db, workspaceId) };
}
