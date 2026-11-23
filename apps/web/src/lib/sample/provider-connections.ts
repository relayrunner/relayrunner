// Settings → Providers' connections for the dev preview (lib/sample/answers.ts), like GET
// /api/providers/connections.
import { BILLING_PROVIDER_IDS, defaultBillingOptions } from "@relayrunner/providers";
import type { ProviderConnection } from "../provider-connections.ts";

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
