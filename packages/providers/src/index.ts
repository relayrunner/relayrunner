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
  "runs-on",
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
  },
  depot: {
    name: "Depot",
    summary: "Hosted runners for GitHub Actions.",
    labels: "depot-*",
    example: "depot-ubuntu-24.04",
    setup: "Sign up for Depot and install its GitHub App on your organization.",
    dashboardUrl: "https://depot.dev/orgs",
    docsUrl: "https://depot.dev/docs/github-actions/overview",
  },
  namespace: {
    name: "Namespace",
    summary: "Hosted runners for GitHub Actions, sized by runner profile.",
    labels: "namespace-profile-*, nscloud-*",
    example: "namespace-profile-default",
    setup: "Sign up for Namespace and connect it to your GitHub organization.",
    dashboardUrl: "https://cloud.namespace.so",
    docsUrl: "https://namespace.so/docs",
  },
  warpbuild: {
    name: "WarpBuild",
    summary: "Hosted runners for GitHub Actions.",
    labels: "warp-*",
    example: "warp-ubuntu-latest-x64-2x",
    setup: "Sign up for WarpBuild and install its GitHub App on your organization.",
    dashboardUrl: "https://app.warpbuild.com",
    docsUrl: "https://docs.warpbuild.com",
  },
  ubicloud: {
    name: "Ubicloud",
    summary: "Hosted runners for GitHub Actions.",
    labels: "ubicloud, ubicloud-*",
    example: "ubicloud-standard-2",
    setup: "Sign up for Ubicloud and install its GitHub App on your organization.",
    dashboardUrl: "https://console.ubicloud.com",
  },
  "runs-on": {
    name: "RunsOn",
    summary: "Runners started in your own AWS account.",
    labels: "runs-on=<run id>/runner=<type>",
    example: "runs-on=${{ github.run_id }}/runner=2cpu-linux-x64",
    setup: "Deploy RunsOn into your AWS account and install the GitHub App it creates.",
    docsUrl: "https://runs-on.com/docs/",
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
  "runs-on",
] as const satisfies readonly ProviderId[];

export type HostedProviderId = (typeof HOSTED_PROVIDER_IDS)[number];

// How each service's labels start, e.g. `depot-ubuntu-24.04-8`. A prefix ending in `-` also
// matches the bare name (`ubicloud`). RunsOn's carry the run id, `runs-on=<run id>/runner=...`.
const LABEL_PREFIXES: Record<HostedProviderId, string[]> = {
  blacksmith: ["blacksmith-"],
  depot: ["depot-"],
  namespace: ["namespace-profile-", "nscloud-"],
  warpbuild: ["warp-"],
  ubicloud: ["ubicloud-"],
  "runs-on": ["runs-on=", "runs-on/"],
};

const matches = (provider: HostedProviderId, lower: string) =>
  LABEL_PREFIXES[provider].some(
    (prefix) => lower.startsWith(prefix) || (prefix.endsWith("-") && lower === prefix.slice(0, -1)),
  );

/** Whether `label` asks for one of `provider`'s runners. */
export const isProviderLabel = (provider: HostedProviderId, label: string) =>
  matches(provider, label.toLowerCase());

/** The hosted provider whose runners a label asks for, or null. */
export function hostedProviderOf(label: string): HostedProviderId | null {
  const lower = label.toLowerCase();
  return HOSTED_PROVIDER_IDS.find((id) => matches(id, lower)) ?? null;
}

/**
 * Where a job ran, by its Job times environment key: `depot:<label>` and the like for providers,
 * plain `container` for the Cloudflare Container, and `machine` for `machine:<id>` and
 * `self-hosted:<group>`, the runners people host themselves.
 */
/** A provider's name, or the id itself when it isn't one RelayRunner knows. */
export const providerName = (id: string) => (isProviderId(id) ? PROVIDERS[id].name : id);

export function providerOfEnvironment(key: string): ProviderId | "machine" {
  if (key === "container") return "cloudflare";
  if (key.startsWith("machine:") || key.startsWith("self-hosted:")) return "machine";
  const id = key.slice(0, key.indexOf(":"));
  return isProviderId(id) ? id : "other";
}
export {
  BASE_BOOK,
  BASE_PRICES,
  dayMs,
  type GitHubRunner,
  githubRate,
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
} from "./prices.ts";
export { type FoundPrice, PRICE_SOURCES, type PriceSource } from "./price-sources.ts";
