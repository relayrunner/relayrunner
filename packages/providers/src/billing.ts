// Providers a workspace can connect with a read-only API token, so RelayRunner reads what they
// actually billed instead of estimating it from job times. The API's adapters
// (apps/api/src/provider-billing) and the dashboard's Settings → Providers page share this list.

import type { ProviderId } from "./index.ts";

export const BILLING_PROVIDER_IDS = [
  "depot",
  "namespace",
  "warpbuild",
] as const satisfies readonly ProviderId[];

export type BillingProviderId = (typeof BILLING_PROVIDER_IDS)[number];

export const isBillingProvider = (id: string): id is BillingProviderId =>
  (BILLING_PROVIDER_IDS as readonly string[]).includes(id);

export interface BillingOption {
  key: string;
  label: string;
  choices: readonly { value: string; label: string }[];
}

export interface BillingProviderInfo {
  /** What kind of token to paste, in the provider's own words. */
  token: string;
  /** Where to make one. */
  tokenUrl: string;
  /** How to make one, in a sentence. */
  tokenHelp: string;
  /** What RelayRunner reads with it. */
  reads: string;
  options?: readonly BillingOption[];
}

export const BILLING_PROVIDERS: Record<BillingProviderId, BillingProviderInfo> = {
  depot: {
    token: "Organization token",
    tokenUrl: "https://depot.dev/orgs/_/settings",
    tokenHelp: "Create an organization token in your Depot organization settings.",
    reads: "Billable and queue time for each job.",
  },
  namespace: {
    token: "Revokable token",
    tokenUrl: "https://namespace.so/docs/reference/cli/token-create",
    tokenHelp: "Run `nsc token create` and paste the token it prints.",
    reads: "Unit minutes per day, and how long each job's instance ran.",
    options: [
      {
        key: "region",
        label: "Region",
        choices: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
    ],
  },
  warpbuild: {
    token: "API key",
    tokenUrl: "https://app.warpbuild.com",
    tokenHelp: "Create an API key with the ci scope in your WarpBuild dashboard.",
    reads: "What each job cost, and daily spend.",
  },
};

/** Each option's first choice, as a provider's defaults. */
export function defaultBillingOptions(id: BillingProviderId): Record<string, string> {
  return Object.fromEntries(
    (BILLING_PROVIDERS[id].options ?? []).map((option) => [option.key, option.choices[0]!.value]),
  );
}
