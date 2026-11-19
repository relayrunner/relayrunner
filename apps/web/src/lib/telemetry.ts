import type { JobLogChoice as LogChoice } from "@relayrunner/activity";
import { api } from "@/lib/api";

export type { LogChoice };

/** An export's health, the same for the telemetry endpoint and the log bucket. */
export type ExportStatus = {
  logs: LogChoice;
  lastSentAt: string | null;
  error: string | null;
  failingSince: string | null;
  pausedAt: string | null;
  // Why the latest job's log that should have gone out didn't.
  logsSkipped: { reason: string; at: string } | null;
};

/** Settings → Telemetry (GET /api/telemetry). Header values never come back, only their last four. */
export type Telemetry = ExportStatus & {
  configured: boolean;
  endpoint: string;
  headers: { name: string; hint: string }[];
  serviceName: string;
  enabled: boolean;
};

export type TelemetryInput = {
  endpoint: string;
  // Leave value out to keep the one saved under that name.
  headers: { name: string; value?: string }[];
  serviceName: string;
  enabled: boolean;
  logs: LogChoice;
};

export type SendResult = { ok: true } | { ok: false; retry: boolean; error: string };

export function getTelemetry() {
  return api<Telemetry>("/telemetry");
}

export function saveTelemetry(input: TelemetryInput) {
  return api<Telemetry>("/telemetry", { method: "PUT", body: JSON.stringify(input) });
}

export function testTelemetry() {
  return api<{ sent: SendResult; telemetry: Telemetry }>("/telemetry/test", {
    method: "POST",
    body: "{}",
  });
}

export function removeTelemetry() {
  return api<Telemetry>("/telemetry", { method: "DELETE" });
}

/** Where common OpenTelemetry backends take traces, and the header each wants. */
export const PRESETS = [
  {
    id: "honeycomb",
    name: "Honeycomb",
    endpoint: "https://api.honeycomb.io",
    headers: ["x-honeycomb-team"],
    help: "Use an ingest API key. For Honeycomb EU, use https://api.eu1.honeycomb.io.",
  },
  {
    id: "grafana",
    name: "Grafana Cloud",
    endpoint: "",
    headers: ["Authorization"],
    help: "Copy the OTLP endpoint and the Basic authorization value from your stack's OpenTelemetry page.",
  },
  {
    id: "axiom",
    name: "Axiom",
    endpoint: "https://api.axiom.co",
    headers: ["Authorization", "X-Axiom-Dataset"],
    help: "Authorization is Bearer and an API token; X-Axiom-Dataset names the dataset for traces.",
  },
  {
    id: "other",
    name: "Other",
    endpoint: "",
    headers: [],
    help: "Any endpoint that accepts OTLP over HTTP with JSON, including an OpenTelemetry Collector.",
  },
] as const;

/** Previews without an API: sending to Honeycomb. */
export function sampleTelemetry(): Telemetry {
  return {
    configured: true,
    endpoint: "https://api.honeycomb.io",
    headers: [{ name: "x-honeycomb-team", hint: "x7Qa" }],
    serviceName: "github-actions",
    enabled: true,
    lastSentAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    error: null,
    failingSince: null,
    pausedAt: null,
    logs: "failed",
    logsSkipped: null,
  };
}

/** Settings → Telemetry → Bucket (GET /api/log-bucket). The secret never comes back. */
export type LogBucket = ExportStatus & {
  configured: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  // The access key id's last four characters.
  keyHint: string;
};

export type LogBucketInput = {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  // Leave both out to keep the saved key; a new access key ID needs its secret.
  accessKeyId?: string;
  secretAccessKey?: string;
  logs: LogChoice;
};

export function getLogBucket() {
  return api<LogBucket>("/log-bucket");
}

export function saveLogBucket(input: LogBucketInput) {
  return api<LogBucket>("/log-bucket", { method: "PUT", body: JSON.stringify(input) });
}

export function testLogBucket() {
  return api<{ sent: SendResult; bucket: LogBucket }>("/log-bucket/test", {
    method: "POST",
    body: "{}",
  });
}

export function removeLogBucket() {
  return api<LogBucket>("/log-bucket", { method: "DELETE" });
}

/** Where common S3-compatible services take objects. */
export const BUCKET_PRESETS = [
  {
    id: "s3",
    name: "Amazon S3",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    help: "Use the bucket's region in the endpoint and below. The key needs s3:PutObject on the bucket.",
  },
  {
    id: "r2",
    name: "Cloudflare R2",
    endpoint: "",
    region: "auto",
    help: "The endpoint is https://<account id>.r2.cloudflarestorage.com. Create an R2 API token with Object Read & Write.",
  },
  {
    id: "gcs",
    name: "Google Cloud Storage",
    endpoint: "https://storage.googleapis.com",
    region: "auto",
    help: "Use an HMAC key from Cloud Storage settings, under Interoperability.",
  },
  {
    id: "other",
    name: "Other",
    endpoint: "",
    region: "",
    help: "Any service that speaks the S3 API, such as MinIO, Backblaze B2 or Wasabi.",
  },
] as const;

/** Previews without an API: archiving to R2. */
export function sampleLogBucket(): LogBucket {
  return {
    configured: true,
    endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
    bucket: "ci-logs",
    region: "auto",
    prefix: "github/",
    keyHint: "9f2c",
    logs: "failed",
    lastSentAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    error: null,
    failingSince: null,
    pausedAt: null,
    logsSkipped: null,
  };
}
