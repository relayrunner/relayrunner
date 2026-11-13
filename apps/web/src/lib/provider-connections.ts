import {
  BILLING_PROVIDER_IDS,
  type BillingProviderId,
  defaultBillingOptions,
} from "@relayrunner/providers";
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

/** What the API's error codes mean, for errorText. */
export const CONNECT_ERRORS: Record<string, string> = {
  token_rejected: "The provider didn't accept that token. Check it and its scope.",
  provider_unreachable: "Couldn't reach the provider. Try again in a minute.",
  invalid_token: "Paste the whole token.",
  invalid_options: "Choose one of the listed options.",
  token_storage_unavailable: "Saving tokens isn't set up on this server yet.",
  forbidden: "Only owners and admins can connect providers.",
};

/** Previews without an API: Depot connected and synced, the others not. */
export function sampleConnections(): { connections: ProviderConnection[] } {
  return {
    connections: BILLING_PROVIDER_IDS.map((provider) => ({
      provider,
      connected: provider === "depot",
      tokenHint: provider === "depot" ? "x7Qa" : null,
      accountName: provider === "depot" ? "acme" : null,
      options: defaultBillingOptions(provider),
      lastSyncedAt: provider === "depot" ? new Date(Date.now() - 12 * 60_000).toISOString() : null,
      failure: null,
      error: null,
      failedAt: null,
      recent:
        provider === "depot"
          ? { jobs: 1284, billableMinutes: 5310, costUsd: null }
          : { jobs: 0, billableMinutes: 0, costUsd: null },
    })),
  };
}
