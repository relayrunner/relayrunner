// The plans each provider sells for GitHub Actions: what a month costs, what it includes and how
// the plans differ. The dashboard lists runner clouds by their cheapest plan and shows every plan
// on the provider's page, next to its machine prices. Nothing tells RelayRunner which plan a
// workspace is on, so nothing here is used to price jobs: costs still come from the price list
// (prices.ts), and the per-minute price shown beside a plan is read from it too.
//
// These live in code only as a small starting point. They will move to the database, so plans can
// be edited without a deploy and a workspace's own plan can be saved against them.
import { BASE_BOOK, listRate } from "./prices.ts";
import type { ProviderId } from "./index.ts";

export const PLATFORMS = ["x64", "arm", "mac", "win"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface ProviderPlan {
  /** The plan's name, as the provider calls it. */
  name: string;
  /**
   * USD a month before any usage. Null when the provider prices it on request; left out where the
   * plan isn't bought for CI (GitHub's).
   */
  feeUsd?: number | null;
  /** What it includes for CI each month, in the provider's terms ("3,000 min", "$10 credit"). */
  included: string;
  /** What sets it apart from the provider's other plans (job-start limits, sizes), when anything. */
  limits?: string;
}

export interface ProviderPlans {
  /** Cheapest first. The first is the one the list shows. */
  plans: readonly ProviderPlan[];
  /** What the limits column means for this provider, such as "Job starts". */
  limitsLabel?: string;
  /** A line under the plans: what's true of all of them. */
  note?: string;
  platforms: readonly Platform[];
  /** Where to sign up and connect the provider's GitHub App. */
  connectUrl?: string;
  /** USD for a 2 vCPU Linux minute, for providers the price list doesn't have. */
  perMinute?: number;
  /** The page these were read from, and when. */
  source: string;
  checked: string;
}

/**
 * Plans for the third-party runner clouds you add by connecting their GitHub App and using their
 * label, plus GitHub's own. Read from each provider's pricing page on `checked`.
 */
export const PLANS: Partial<Record<ProviderId, ProviderPlans>> = {
  blacksmith: {
    plans: [
      { name: "Pay as you go", feeUsd: 0, included: "3,000 min a month" },
      { name: "Enterprise", feeUsd: null, included: "Custom" },
    ],
    note: "No concurrency limits on any plan.",
    platforms: ["x64", "arm", "mac", "win"],
    connectUrl: "https://app.blacksmith.sh",
    source: "https://www.blacksmith.sh/pricing",
    checked: "2026-11-17",
  },
  depot: {
    plans: [
      { name: "Developer", feeUsd: 20, included: "2,000 min a month" },
      { name: "Startup", feeUsd: 200, included: "20,000 min a month" },
      { name: "Business", feeUsd: null, included: "Custom" },
    ],
    note: "Paid plans start with a 7-day trial. Concurrency is unlimited on every plan.",
    platforms: ["x64", "arm", "mac", "win"],
    connectUrl: "https://depot.dev/sign-up",
    source: "https://depot.dev/pricing",
    checked: "2026-11-17",
  },
  namespace: {
    plans: [
      { name: "Developer", feeUsd: 0, included: "None", limits: "32 vCPU" },
      { name: "Team", feeUsd: 100, included: "100,000 unit min a month", limits: "64 vCPU" },
      { name: "Business", feeUsd: 250, included: "250,000 unit min a month", limits: "160 vCPU" },
      { name: "Enterprise", feeUsd: null, included: "Custom", limits: "Custom" },
    ],
    limitsLabel: "Linux at once",
    note: "A unit minute is 1 vCPU and 2 GB for a minute, so a 2 vCPU Linux runner uses 2 a minute. Windows counts double and macOS ten times.",
    platforms: ["x64", "arm", "mac", "win"],
    connectUrl: "https://cloud.namespace.so",
    // 2 vCPU, 4 GB past the plan's unit minutes.
    perMinute: 0.003,
    source: "https://namespace.so/pricing",
    checked: "2026-11-17",
  },
  warpbuild: {
    plans: [
      { name: "Pay as you go", feeUsd: 0, included: "$10 credit at sign-up" },
      { name: "Enterprise", feeUsd: null, included: "Custom" },
    ],
    note: "Job concurrency is unlimited.",
    platforms: ["x64", "arm", "mac", "win"],
    connectUrl: "https://app.warpbuild.com",
    source: "https://www.warpbuild.com/pricing",
    checked: "2026-11-17",
  },
  ubicloud: {
    plans: [{ name: "Pay as you go", feeUsd: 0, included: "$2.50 credit a month" }],
    note: "Needs a card on file before it runs anything.",
    platforms: ["x64", "arm"],
    connectUrl: "https://console.ubicloud.com/?setup=github_actions",
    source: "https://www.ubicloud.com/docs/about/pricing",
    checked: "2026-11-17",
  },
  boat: {
    plans: [
      {
        name: "$20 plan",
        feeUsd: 20,
        included: "$20 of VM time",
        limits: "12/min · 60/hr · 200/day",
      },
      {
        name: "$100 plan",
        feeUsd: 100,
        included: "$100 of VM time",
        limits: "30/min · 210/hr · 840/day",
      },
      {
        name: "$500 plan",
        feeUsd: 500,
        included: "$500 of VM time",
        limits: "65/min · 420/hr · 1,680/day",
      },
      {
        name: "$2,000 plan",
        feeUsd: 2000,
        included: "$2,000 of VM time",
        limits: "90/min · 600/hr · 2,400/day",
      },
    ],
    limitsLabel: "Job starts",
    note: "CI needs the $20 plan or higher. Each plan's fee comes back as VM time at machine prices, and unused time ends with the month. boat-xlarge needs $100 or more.",
    platforms: ["x64"],
    connectUrl: "https://boat.dev/dashboard?tab=billing",
    source: "https://docs.boat.dev/pricing",
    checked: "2026-11-17",
  },
  github: {
    plans: [
      { name: "Free", included: "$12 a month, about 2,000 Linux min" },
      { name: "Pro", included: "$18 a month, about 3,000 Linux min" },
      { name: "Team", included: "$18 a month, about 3,000 Linux min" },
      { name: "Enterprise Cloud", included: "$300 a month, about 50,000 Linux min" },
    ],
    note: "Each plan includes a dollar amount of runner time in private repositories, reset every billing cycle. Standard runners are free in public repositories.",
    platforms: ["x64", "arm", "mac", "win"],
    source: "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
    checked: "2026-11-17",
  },
};

/** The runner clouds the Providers page offers to add: GitHub's own runners need no adding. */
export const RUNNER_CLOUD_IDS = (Object.keys(PLANS) as ProviderId[]).filter(
  (id) => id !== "github",
);

export const providerPlans = (provider: string): ProviderPlans | undefined =>
  Object.hasOwn(PLANS, provider) ? PLANS[provider as ProviderId] : undefined;

// The 2 vCPU Linux runner each provider's per-minute price is quoted for.
const TWO_VCPU_LABEL: Partial<Record<ProviderId, string>> = {
  blacksmith: "blacksmith-2vcpu-ubuntu-2404",
  depot: "depot-ubuntu-24.04",
  warpbuild: "warp-ubuntu-latest-x64-2x",
  ubicloud: "ubicloud-standard-2",
  boat: "boat-small",
};

/** USD for a 2 vCPU Linux minute at list price, or null when unknown. */
export function twoVcpuMinute(provider: string): number | null {
  const label = TWO_VCPU_LABEL[provider as ProviderId];
  if (label) return listRate(BASE_BOOK, provider as ProviderId, label);
  return providerPlans(provider)?.perMinute ?? null;
}

/** What the cheapest plan costs a month: "$20/mo", or "No monthly fee". */
export function startsAt({ plans }: ProviderPlans): string {
  const fee = plans[0]!.feeUsd;
  return fee ? `$${fee.toLocaleString("en-US")}/mo` : "No monthly fee";
}
