// The plans each provider sells for GitHub Actions: what a month costs, what it includes and how
// the plans differ. The dashboard lists runner clouds by their cheapest plan for real CI and shows every plan
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
  /**
   * A free trial, or a free tier too small for real CI (one machine at a time), so the list's
   * Starts at skips it and shows the plan people need.
   */
  trial?: boolean;
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
    // 2 vCPU, 8 GB on the pay-as-you-go Developer plan; minutes inside a paid plan cost a third less.
    perMinute: 0.006,
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
  // Listed runner clouds, read from their own pages on 2026-11-17.
  starsling: {
    plans: [{ name: "Pay as you go", feeUsd: 0, included: "2,000 min in the first month" }],
    note: "Concurrency is unlimited. GPU runners are available on request.",
    platforms: ["x64"],
    connectUrl: "https://runners.starsling.dev/login",
    source: "https://starsling.dev/pricing",
    checked: "2026-11-17",
  },
  monkci: {
    plans: [
      { name: "Free trial", feeUsd: 0, included: "5,000 min for 14 days", trial: true },
      { name: "Pro", feeUsd: 20, included: "5,000 min a month" },
      { name: "Max", feeUsd: 100, included: "20,000 min a month" },
      { name: "Custom", feeUsd: null, included: "Custom" },
    ],
    note: "Builds stop when the trial ends. Users are unlimited. GitHub organizations only.",
    platforms: ["x64"],
    connectUrl: "https://app.monkci.com",
    source: "https://monkci.com/pricing",
    checked: "2026-11-17",
  },
  runloft: {
    plans: [{ name: "Pay as you go", feeUsd: 0, included: "3,000 Linux min a month" }],
    note: "Credit is prepaid from $5. Arm, Windows and macOS are turned on per account on request, and free minutes don't cover Windows or macOS.",
    platforms: ["x64", "arm", "mac", "win"],
    connectUrl: "https://runloft.dev/app/",
    source: "https://runloft.dev/pricing/",
    checked: "2026-11-17",
  },
  latchkey: {
    plans: [
      {
        name: "Developer",
        feeUsd: 5,
        included: "2,000 min a month",
        limits: "20 jobs, 1 repo, 1 seat",
      },
      {
        name: "Launch",
        feeUsd: 19,
        included: "4,000 min a month",
        limits: "40 jobs, 10 repos, 3 seats",
      },
      {
        name: "Scale",
        feeUsd: 49,
        included: "6,000 min a month",
        limits: "80 jobs, 40 repos, 5 seats",
      },
      { name: "Enterprise", feeUsd: null, included: "Custom", limits: "Custom" },
    ],
    limitsLabel: "Jobs at once, repos, seats",
    note: "Launch has a 30-day trial. Minutes count as latchkey-small minutes. Extra seats are $5 each. GitHub organizations only.",
    platforms: ["x64"],
    connectUrl: "https://github.com/apps/latchkey-app",
    source: "https://latchkey.dev/pricing",
    checked: "2026-11-17",
  },
  berrybox: {
    plans: [
      { name: "Pay as you go", feeUsd: 0, included: "None", limits: "16 vCPU" },
      { name: "Build", feeUsd: 100, included: "$100 credit a month", limits: "64 vCPU" },
    ],
    limitsLabel: "At once",
    note: "Credit is prepaid, $20 at a time. Private repositories in GitHub organizations only.",
    platforms: ["x64"],
    connectUrl: "https://berrybox.io/login",
    source: "https://docs.berrybox.io/docs/teams-and-billing/billing",
    checked: "2026-11-17",
  },
  celesto: {
    plans: [{ name: "Pay as you go", feeUsd: 0, included: "$5 trial credit, Micro only" }],
    note: "Credit is prepaid from $2.01. The trial credit lasts 30 days.",
    platforms: ["x64"],
    connectUrl: "https://celesto.ai/sign-up",
    source: "https://celesto.ai/pricing",
    checked: "2026-11-17",
  },
  instabox: {
    plans: [
      {
        name: "Free",
        feeUsd: 0,
        included: "None",
        limits: "1 machine, instabox-medium only",
        trial: true,
      },
      {
        name: "Pro",
        feeUsd: 20,
        included: "$20 credit a month",
        limits: "100 machines, up to 8 vCPU",
      },
      {
        name: "Builder",
        feeUsd: 100,
        included: "$100 credit a month",
        limits: "200 machines, up to 16 vCPU",
      },
      {
        name: "Team",
        feeUsd: 500,
        included: "$500 credit a month",
        limits: "500 machines, up to 32 vCPU",
      },
      { name: "Enterprise", feeUsd: null, included: "Custom", limits: "Custom" },
    ],
    limitsLabel: "At once",
    note: "Usage is $0.004 per vCPU-hour plus $0.00225 per GiB-hour, billed per second, on top of the plan.",
    platforms: ["x64"],
    connectUrl: "https://instabox.sh",
    source: "https://instabox.sh/docs/pricing",
    checked: "2026-11-17",
  },
  lizard: {
    plans: [
      {
        name: "Trial",
        feeUsd: 0,
        included: "50 small, 20 medium, 10 large jobs",
        limits: "5 jobs, 7 days",
        trial: true,
      },
      { name: "Pro", feeUsd: 19, included: "$19 usage a month", limits: "5 jobs" },
      { name: "Pro 5x", feeUsd: 99, included: "$99 usage a month", limits: "20 jobs" },
      { name: "Pro 20x", feeUsd: 499, included: "$499 usage a month", limits: "20 jobs" },
      { name: "Enterprise", feeUsd: null, included: "Custom", limits: "Custom" },
    ],
    limitsLabel: "Jobs at once",
    note: "Plans cover all of Lizard (apps, databases, Sandboxes), and usage past the plan's is pay as you go, per second. The trial needs a card, and once a size's trial jobs are used, jobs of that size are skipped until Pro. GitHub organizations only.",
    platforms: ["x64"],
    connectUrl: "https://lizard.build/ci",
    source: "https://lizard.build/pricing",
    checked: "2026-11-18",
  },
  groundbox: {
    plans: [
      {
        name: "Free",
        feeUsd: 0,
        included: "3,000 min and $5 usage a month",
        limits: "20 jobs at once, up to 1 hour, no card",
      },
      { name: "Paid", feeUsd: 20, included: "$20 usage a month", limits: "Jobs up to 6 hours" },
    ],
    note: "Minutes count in 2 vCPU minutes, so a 4 vCPU minute uses 2. Usage past the plan's is pay as you go, billed per second, and Paid is also $200 a year. Linux x64 only, in public and private repos, for organizations and personal accounts.",
    platforms: ["x64"],
    connectUrl: "https://app.groundbox.dev",
    source: "https://groundbox.dev/pricing",
    checked: "2026-11-21",
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
  starsling: "starsling-ubuntu-24.04-2",
  monkci: "monkci-ubuntu-24.04-2",
  runloft: "runloft-ubuntu-24.04",
  latchkey: "latchkey-small",
  berrybox: "berrybox-2vcpu-ubuntu-2404",
  celesto: "celesto-standard",
  instabox: "instabox-small",
  lizard: "lizard-small-ubuntu-2404",
  groundbox: "groundbox-2vcpu",
};

/** USD for a 2 vCPU Linux minute at list price, or null when unknown. */
export function twoVcpuMinute(provider: string): number | null {
  const label = TWO_VCPU_LABEL[provider as ProviderId];
  if (label) return listRate(BASE_BOOK, provider as ProviderId, label);
  return providerPlans(provider)?.perMinute ?? null;
}

/**
 * What the cheapest plan you can run real CI on costs a month: "$20/mo", or "Pay as you go" when
 * usage is all you pay. Trials and one-machine free tiers don't count.
 */
export function startsAt({ plans }: ProviderPlans): string {
  const fee = (plans.find((plan) => !plan.trial) ?? plans[0]!).feeUsd;
  return fee ? `$${fee.toLocaleString("en-US")}/mo` : "Pay as you go";
}
