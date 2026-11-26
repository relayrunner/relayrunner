import type { BillingProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";
/** One provider on Settings → Providers (GET /api/providers/connections). Never the token. */
export type ProviderConnection = {
  provider: BillingProviderId;
  connected: boolean;
  tokenHint: string | null;
  accountName: string | null;
  options: Record<string, string>;
  lastSyncedAt: string | null;
  failure: "token_rejected" | "error" | null;
  error: string | null;
  failedAt: string | null;
  recent: { jobs: number; billableMinutes: number; costUsd: number | null };
};

export type TestResult = {
  ok: boolean;
  error?: string;
  message?: string;
  connection: ProviderConnection;
};

export function listConnections() {
  return api<{ connections: ProviderConnection[] }>("/providers/connections");
}

export function connectProvider(provider: string, token: string, options: Record<string, string>) {
  return api<ProviderConnection>(`/providers/${provider}/connection`, {
    method: "PUT",
    body: JSON.stringify({ token, options }),
  });
}

export function testConnection(provider: string) {
  return api<TestResult>(`/providers/${provider}/connection/test`, { method: "POST", body: "{}" });
}

export function removeConnection(provider: string) {
  return api<ProviderConnection>(`/providers/${provider}/connection`, { method: "DELETE" });
}
