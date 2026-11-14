import { api } from "@/lib/api";

/** Settings → Telemetry (GET /api/telemetry). Header values never come back, only their last four. */
export type Telemetry = {
  configured: boolean;
  endpoint: string;
  headers: { name: string; hint: string }[];
  serviceName: string;
  enabled: boolean;
  lastSentAt: string | null;
  error: string | null;
  failingSince: string | null;
  pausedAt: string | null;
};

export type TelemetryInput = {
  endpoint: string;
  // Leave value out to keep the one saved under that name.
  headers: { name: string; value?: string }[];
  serviceName: string;
  enabled: boolean;
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
  };
}
