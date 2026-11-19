// The places a job can run that RelayRunner recognises by its runs-on labels: hosted runner
// services, GitHub's own runners, and RelayRunner's Cloudflare Container. These are the facts every
// workspace shares, so they live here in code and change by pull request. The API's label matching
// (apps/api/src/cloud-providers.ts) and the dashboard's logos and colours build on this list.

export const PROVIDER_IDS = [
  "blacksmith",
  "depot",
  "namespace",
  "warpbuild",
  "ubicloud",
  "boat",
  "runs-on",
  "starsling",
  "monkci",
  "runloft",
  "latchkey",
  "berrybox",
  "celesto",
  "instabox",
  "lizard",
  "github",
  "cloudflare",
  "other",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  name: string;
  /** One line on what it is, shown under its name. */
  summary: string;
  /** How its labels look, e.g. `depot-*`. */
  labels: string;
  /** A runs-on value that asks for one of its runners. */
  example?: string;
  /** What to do before a job can run there, shown until it has been used. */
  setup?: string;
  /** Its own dashboard, where its runners and billing live. */
  dashboardUrl?: string;
  docsUrl?: string;
  /**
   * Starts Hidden: recognised by its labels but not offered on the Providers page until an
   * operator makes it Live in Admin › Providers. Set it when adding a provider.
   */
  hidden?: boolean;
  /** Listed first on the Providers page, with the names people know, until an operator changes it. */
  featured?: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  blacksmith: {
    name: "Blacksmith",
    summary: "Hosted runners for GitHub Actions.",
    labels: "blacksmith-*",
    example: "blacksmith-4vcpu-ubuntu-2404",
    setup: "Sign up for Blacksmith and install its GitHub App on your organization.",
    dashboardUrl: "https://app.blacksmith.sh",
    docsUrl: "https://docs.blacksmith.sh",
    featured: true,
  },
  depot: {
    name: "Depot",
    summary: "Hosted runners for GitHub Actions.",
    labels: "depot-*",
    example: "depot-ubuntu-24.04",
    setup: "Sign up for Depot and install its GitHub App on your organization.",
    dashboardUrl: "https://depot.dev/orgs",
    docsUrl: "https://depot.dev/docs/github-actions/overview",
    featured: true,
  },
  namespace: {
    name: "Namespace",
    summary: "Hosted runners for GitHub Actions, sized by runner profile.",
    labels: "namespace-profile-*, nscloud-*",
    example: "namespace-profile-default",
    setup: "Sign up for Namespace and connect it to your GitHub organization.",
    dashboardUrl: "https://cloud.namespace.so",
    docsUrl: "https://namespace.so/docs",
    featured: true,
  },
  warpbuild: {
    name: "WarpBuild",
    summary: "Hosted runners for GitHub Actions.",
    labels: "warp-*",
    example: "warp-ubuntu-latest-x64-2x",
    setup: "Sign up for WarpBuild and install its GitHub App on your organization.",
    dashboardUrl: "https://app.warpbuild.com",
    docsUrl: "https://docs.warpbuild.com",
    featured: true,
  },
  ubicloud: {
    name: "Ubicloud",
    summary: "Hosted runners for GitHub Actions.",
    labels: "ubicloud, ubicloud-*",
    example: "ubicloud-standard-2",
    setup: "Sign up for Ubicloud and install its GitHub App on your organization.",
    dashboardUrl: "https://console.ubicloud.com",
    featured: true,
  },
  boat: {
    name: "Boat",
    summary: "Hosted Linux runners for GitHub Actions, billed per second.",
    labels: "boat, boat-*",
    example: "boat",
    setup:
      "Get Boat's $20 plan or higher, then run boat ci connect to install the boat CI GitHub App on your organization.",
    dashboardUrl: "https://boat.dev",
    docsUrl: "https://docs.boat.dev/ci",
  },
  "runs-on": {
    name: "RunsOn",
    summary: "Runners started in your own AWS account.",
    labels: "runs-on=<run id>/runner=<type>",
    example: "runs-on=${{ github.run_id }}/runner=2cpu-linux-x64",
    setup: "Deploy RunsOn into your AWS account and install the GitHub App it creates.",
    docsUrl: "https://runs-on.com/docs/",
  },
  // Runner clouds added 2026-11-17, read from each one's own docs then and on 2026-11-18.
  starsling: {
    name: "StarSling",
    summary: "Hosted Linux runners for GitHub Actions, with GPU runners on request.",
    labels: "starsling-ubuntu-<version>-<vcpus>",
    example: "starsling-ubuntu-24.04-2",
    setup:
      "Sign up for StarSling with GitHub and install its GitHub App on your organization from its dashboard. It doesn't run personal accounts' repos.",
    dashboardUrl: "https://runners.starsling.dev",
    docsUrl: "https://docs.starsling.dev",
  },
  monkci: {
    name: "Monk CI",
    summary: "Hosted Linux runners for GitHub Actions.",
    labels: "monkci-ubuntu-24.04-<vcpus>",
    example: "monkci-ubuntu-24.04-2",
    setup:
      "Sign up for Monk CI and have an organization owner install its GitHub App on the repos that should use it. It doesn't run personal accounts' repos.",
    dashboardUrl: "https://app.monkci.com",
    docsUrl: "https://monkci.com/docs",
  },
  runloft: {
    name: "Runloft",
    summary: "Hosted runners for GitHub Actions, billed per second.",
    labels: "runloft-*",
    example: "runloft-ubuntu-24.04",
    setup:
      "Sign in to Runloft with GitHub and install its GitHub App. Runners bigger than 2 vCPU, and Arm, Windows and macOS, run once Runloft turns them on for your account.",
    dashboardUrl: "https://runloft.dev/app/",
    docsUrl: "https://runloft.dev/docs/",
  },
  latchkey: {
    name: "Latchkey",
    summary: "Hosted Linux runners for GitHub Actions.",
    labels: "latchkey-small, -medium, -large, -xlarge",
    example: "latchkey-small",
    setup:
      "Sign up for Latchkey and install its GitHub App on your organization. Its runners don't take personal accounts' repos, and its $5 plan covers one repo.",
    dashboardUrl: "https://latchkey.dev/sign-in",
    docsUrl: "https://latchkey.dev/documentation",
  },
  berrybox: {
    name: "BerryBox",
    summary: "Hosted Linux runners for GitHub Actions, billed per second.",
    labels: "berrybox-<vcpus>vcpu-ubuntu-2404",
    example: "berrybox-2vcpu-ubuntu-2404",
    setup:
      "Sign up for BerryBox, install its GitHub App on your organization, add credit and turn on the sizes you want in team settings. It runs organizations' private repos only.",
    dashboardUrl: "https://berrybox.io/login",
    docsUrl: "https://docs.berrybox.io",
  },
  celesto: {
    name: "Celesto",
    summary: "Linux runners for GitHub Actions on Celesto's sandboxes.",
    labels: "celesto, celesto-*",
    example: "celesto-standard",
    setup:
      "Sign up for Celesto and install the celesto-ci GitHub App, then add credit: the trial runs celesto-micro only.",
    dashboardUrl: "https://celesto.ai/dashboard",
    docsUrl: "https://celesto.ai/docs/ci",
  },
  instabox: {
    name: "InstaBox",
    summary: "Linux runners for GitHub Actions on InstaBox's sandboxes.",
    labels: "instabox-*",
    example: "instabox-medium",
    setup:
      "Sign up for InstaBox and connect GitHub from the CI page of its dashboard. The Free plan runs instabox-medium only.",
    dashboardUrl: "https://instabox.sh",
    docsUrl: "https://instabox.sh/docs/use-cases/ci",
  },
  lizard: {
    name: "Lizard",
    summary: "Linux runners for GitHub Actions on Lizard's Firecracker VMs, billed per second.",
    labels: "lizard-small, -medium, -large-ubuntu-2404",
    example: "lizard-medium-ubuntu-2404",
    setup:
      "Sign up for Lizard, open GitHub Actions in its dashboard and connect your organization. Its runners don't take personal accounts' repos.",
    dashboardUrl: "https://lizard.build",
    docsUrl: "https://lizard.build/ci",
    hidden: true,
  },
  github: {
    name: "GitHub",
    summary: "GitHub's own hosted runners, billed per minute in private repos.",
    labels: "ubuntu-*, windows-*, macos-*, or a larger runner's own name",
    example: "ubuntu-latest",
    setup: "Nothing to set up. GitHub's runners work in every repository.",
    docsUrl: "https://docs.github.com/en/actions/reference/runners/github-hosted-runners",
  },
  cloudflare: {
    name: "Cloudflare",
    summary: "RelayRunner's own runner, a Cloudflare Container started for each job.",
    labels: "relayrunner-container",
    example: "relayrunner-container",
    setup:
      "Container runners are in early access. Email feedback@relayrunner.app to turn them on for your organization.",
  },
  other: {
    name: "Other",
    summary: "Labels RelayRunner doesn't recognise yet: another service, or a custom runner.",
    labels: "anything else",
  },
};

export const isProviderId = (value: string): value is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(value);

/**
 * The hosted runner services a relay can send a job to. Each runs a job under the customer's own
 * account through its own GitHub App, which picks up any job queued with one of its labels, so
 * routing to one only means answering one of its labels. Each is a step in the runner order and an
 * input on the relay, both named by its id.
 */
export const HOSTED_PROVIDER_IDS = [
  "blacksmith",
  "depot",
  "namespace",
  "warpbuild",
  "ubicloud",
  "boat",
  "runs-on",
  "starsling",
  "monkci",
  "runloft",
  "latchkey",
  "berrybox",
  "celesto",
  "instabox",
  "lizard",
] as const satisfies readonly ProviderId[];

export type HostedProviderId = (typeof HOSTED_PROVIDER_IDS)[number];

// How each service's labels start, e.g. `depot-ubuntu-24.04-8`. A prefix ending in `-` also
// matches the bare name (`ubicloud`). RunsOn's carry the run id, `runs-on=<run id>/runner=...`.
// Boat's take options after a `/`, as in `boat-large/debug`.
export const LABEL_PREFIXES: Record<HostedProviderId, string[]> = {
  blacksmith: ["blacksmith-"],
  depot: ["depot-"],
  namespace: ["namespace-profile-", "nscloud-"],
  warpbuild: ["warp-"],
  ubicloud: ["ubicloud-"],
  boat: ["boat-", "boat/"],
  "runs-on": ["runs-on=", "runs-on/"],
  starsling: ["starsling-"],
  monkci: ["monkci-"],
  runloft: ["runloft-"],
  latchkey: ["latchkey-"],
  berrybox: ["berrybox-"],
  celesto: ["celesto-"],
  instabox: ["instabox-"],
  lizard: ["lizard-"],
};

/** Whether a lowercase label starts with one of `prefixes`, or is the bare name one ends in `-`. */
export const matchesPrefix = (prefixes: readonly string[], lower: string) =>
  prefixes.some(
    (prefix) => lower.startsWith(prefix) || (prefix.endsWith("-") && lower === prefix.slice(0, -1)),
  );

const matches = (provider: HostedProviderId, lower: string) =>
  matchesPrefix(LABEL_PREFIXES[provider], lower);

/** Whether `label` asks for one of `provider`'s runners. */
export const isProviderLabel = (provider: HostedProviderId, label: string) =>
  matches(provider, label.toLowerCase());

/** The hosted provider whose runners a label asks for, or null. */
export function hostedProviderOf(label: string): HostedProviderId | null {
  const lower = label.toLowerCase();
  return HOSTED_PROVIDER_IDS.find((id) => matches(id, lower)) ?? null;
}

// How each service's GitHub App slug reads, as listed in an org's installed apps. Matched loosely:
// RunsOn's app is one each customer creates from its stack, so its slug varies.
export const APP_SLUG_PATTERNS: Record<HostedProviderId, RegExp> = {
  blacksmith: /blacksmith/,
  depot: /depot/,
  namespace: /namespace|nscloud/,
  warpbuild: /warpbuild/,
  ubicloud: /ubicloud/,
  boat: /boat/,
  "runs-on": /runs-?on/,
  starsling: /starsling/,
  monkci: /monk-?ci/,
  runloft: /runloft/,
  latchkey: /latchkey/,
  berrybox: /berrybox/,
  celesto: /celesto/,
  instabox: /instabox/,
  lizard: /lizard/,
};

/**
 * Hosted providers that refuse public repos' jobs, so the Router skips them for public repos
 * instead of leaving the job queued. Boat until the account allows them
 * (https://docs.boat.dev/ci); BerryBox runs private repos only
 * (https://docs.berrybox.io/docs/getting-started/availability).
 */
export const SKIPS_PUBLIC_REPOS: readonly HostedProviderId[] = ["boat", "berrybox"];

/**
 * Hosted providers whose runners only serve GitHub organizations, so the Router skips them for a
 * personal account's repos instead of leaving the job queued.
 * https://docs.starsling.dev, https://monkci.com/docs/quickstart,
 * https://latchkey.dev/documentation/install-the-github-app,
 * https://docs.berrybox.io/docs/getting-started/availability, https://lizard.build/ci
 */
export const SKIPS_PERSONAL_ACCOUNTS: readonly HostedProviderId[] = [
  "starsling",
  "monkci",
  "latchkey",
  "berrybox",
  "lizard",
];

/** The hosted providers whose GitHub App is among these installed app slugs. */
export function providersOfAppSlugs(slugs: string[]): HostedProviderId[] {
  const lower = slugs.map((slug) => slug.toLowerCase());
  return HOSTED_PROVIDER_IDS.filter((id) => lower.some((slug) => APP_SLUG_PATTERNS[id].test(slug)));
}

/** A provider's name, or the id itself when it isn't one RelayRunner knows. */
export const providerName = (id: string) => (isProviderId(id) ? PROVIDERS[id].name : id);

/**
 * Where a job ran, by its Job times environment key: `depot:<label>` and the like for providers,
 * plain `container` for the Cloudflare Container, and `machine` for `machine:<id>` and
 * `self-hosted:<group>`, the runners people host themselves. `known` says which ids are
 * providers; pass a catalog's to count the ones operators added.
 */
export function providerOfEnvironment(
  key: string,
  known: (id: string) => boolean = isProviderId,
): string {
  if (key === "container") return "cloudflare";
  if (key.startsWith("machine:") || key.startsWith("self-hosted:")) return "machine";
  const id = key.slice(0, key.indexOf(":"));
  return known(id) ? id : "other";
}

/** The runner label in an environment key: `linux-2-core` for `github:linux-2-core`. */
export const labelOfEnvironment = (key: string) => key.slice(key.indexOf(":") + 1);
export {
  AUTO_SIZE_MESSAGE,
  AUTO_SIZES,
  type AutoSize,
  DEFAULT_AUTO_SIZE,
  isAutoSize,
  labelForSize,
} from "./auto-sizes.ts";
export {
  ADDED_RATE,
  BASE_BOOK,
  BASE_PRICES,
  dayMs,
  GITHUB_LABELS,
  type GitHubRunner,
  githubRate,
  hasListPrices,
  isRate,
  listRate,
  type PriceBook,
  priceBook,
  type PricedProvider,
  type PriceRow,
  PRICES_CHECKED,
  type RatePrices,
  RATES,
  rateName,
  ratePrices,
  rateText,
  runnerPlatform,
  type RunnerPlatform,
  type RunnerSize,
  runnerSize,
  sizeText,
} from "./prices.ts";
export { type FoundPrice, PRICE_SOURCES, type PriceSource } from "./price-sources.ts";
export {
  BILLING_PROVIDER_IDS,
  BILLING_PROVIDERS,
  type BillingOption,
  type BillingProviderId,
  type BillingProviderInfo,
  defaultBillingOptions,
  isBillingProvider,
} from "./billing.ts";
export {
  type Platform,
  PLATFORMS,
  PLANS,
  type ProviderPlan,
  type ProviderPlans,
  providerPlans,
  RUNNER_CLOUD_IDS,
  startsAt,
  twoVcpuMinute,
} from "./plans.ts";
