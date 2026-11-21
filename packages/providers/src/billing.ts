// Providers a workspace can connect with a read-only API token, so RelayRunner reads what they
// actually billed instead of estimating it from job times. The API's adapters
// (apps/api/src/provider-billing) and the dashboard's Settings → Providers page share this list.

import type { ProviderId } from "./index.ts";

export const BILLING_PROVIDER_IDS = [
  "blacksmith",
  "boat",
  "depot",
  "groundbox",
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
  /**
   * The scopes the token needs, each with what it's for, when the provider asks for them as the
   * token is made. Settings › Providers lists them by the token field.
   */
  scopes?: readonly { scope: string; for: string }[];
  options?: readonly BillingOption[];
  /**
   * The provider account is a GitHub organization: a connection is for the workspace's own, and a
   * token for any other is refused.
   */
  githubOrganization?: boolean;
  /** A terminal command that makes the token and connects it, offered before pasting one. */
  command?: string;
  /** The connection only reads the plan's limits for the Router, so it syncs no usage. */
  limitsOnly?: boolean;
  /** The synced jobs carry what they cost but not how long they ran, so the card names no minutes. */
  costOnly?: boolean;
}

export const BILLING_PROVIDERS: Record<BillingProviderId, BillingProviderInfo> = {
  blacksmith: {
    token: "Organization token",
    tokenUrl: "https://docs.blacksmith.sh/blacksmith-cli/overview",
    tokenHelp:
      "As a Blacksmith org admin, run `blacksmith org-token create`, approve it for this workspace's GitHub organization, and paste the token it prints.",
    command: "npx relayrunner blacksmith connect",
    reads: "Billable minutes and cost per day, and each job's billable minutes.",
    githubOrganization: true,
  },
  boat: {
    token: "API key",
    tokenUrl: "https://docs.boat.dev/api-keys",
    tokenHelp:
      "Create a Boat API key allowed only the account.read action, and paste it. It starts with boat_.",
    reads:
      "How many job starts your plan has left this hour and day, so jobs go to the next step in your runner order when Boat has none left.",
    limitsOnly: true,
  },
  depot: {
    token: "Organization token",
    tokenUrl: "https://depot.dev/orgs/_/settings",
    tokenHelp: "Create an organization token in your Depot organization settings.",
    reads: "Billable and queue time for each job.",
  },
  groundbox: {
    token: "API key",
    tokenUrl: "https://app.groundbox.dev",
    tokenHelp:
      "In Groundbox's dashboard, create an API key with only these two scopes, and paste it. It starts with `gbx_`.",
    scopes: [
      { scope: "account:read", for: "free minutes left and whether Groundbox is holding jobs" },
      { scope: "billing:read", for: "what each job cost, for the hourly sync" },
    ],
    reads:
      "Free minutes left this month, what each job cost, and whether Groundbox is holding jobs, so the Router can pass jobs on before Groundbox would hold them.",
    costOnly: true,
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
