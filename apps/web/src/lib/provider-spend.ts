import type { HostedProviderId } from "@relayrunner/providers";
import { api } from "./api";

/**
 * What the workspace's GitHub account has spent on each priced provider this month, at list
 * prices, in dollars (GET /api/providers/spend). A provider with no jobs this month is left out.
 * The Router shows it against each step's spend cap. GitHub-hosted's spend is its billed
 * netAmount in GET /api/usage/actions.
 */
export type ProviderSpend = Partial<Record<HostedProviderId, number>>;

export function getProviderSpend() {
  return api<{ spend: ProviderSpend }>("/providers/spend").then((body) => body.spend);
}
