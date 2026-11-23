// Telemetry and log archive settings for the dev preview (lib/sample/answers.ts), like GET
// /api/telemetry and /api/log-bucket.
import type { LogBucket, Telemetry } from "../telemetry.ts";

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
