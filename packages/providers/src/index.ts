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
    dashboardUrl: "https://app.blacksmith.sh",
    docsUrl: "https://docs.blacksmith.sh",
  },
  depot: {
    name: "Depot",
    summary: "Hosted runners for GitHub Actions.",
    labels: "depot-*",
    example: "depot-ubuntu-24.04",
    dashboardUrl: "https://depot.dev/orgs",
    docsUrl: "https://depot.dev/docs/github-actions/overview",
  },
  namespace: {
    name: "Namespace",
    summary: "Hosted runners for GitHub Actions, sized by runner profile.",
    labels: "namespace-profile-*, nscloud-*",
    example: "namespace-profile-default",
    dashboardUrl: "https://cloud.namespace.so",
    docsUrl: "https://namespace.so/docs",
  },
  warpbuild: {
    name: "WarpBuild",
    summary: "Hosted runners for GitHub Actions.",
    labels: "warp-*",
    example: "warp-ubuntu-latest-x64-2x",
    dashboardUrl: "https://app.warpbuild.com",
    docsUrl: "https://docs.warpbuild.com",
  },
  ubicloud: {
    name: "Ubicloud",
    summary: "Hosted runners for GitHub Actions.",
    labels: "ubicloud, ubicloud-*",
    example: "ubicloud-standard-2",
    dashboardUrl: "https://console.ubicloud.com",
  },
  "runs-on": {
    name: "RunsOn",
    summary: "Runners started in your own AWS account.",
    labels: "runs-on=<run id>/runner=<type>",
    example: "runs-on=${{ github.run_id }}/runner=2cpu-linux-x64",
    docsUrl: "https://runs-on.com/docs/",
  },
  github: {
    name: "GitHub",
    summary: "GitHub's own hosted runners, billed per minute in private repos.",
    labels: "ubuntu-*, windows-*, macos-*, or a larger runner's own name",
    example: "ubuntu-latest",
    docsUrl: "https://docs.github.com/en/actions/reference/runners/github-hosted-runners",
  },
  cloudflare: {
    name: "Cloudflare",
    summary: "RelayRunner's own runner, a Cloudflare Container started for each job.",
    labels: "relayrunner-container",
    example: "relayrunner-container",
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
 * Where a job ran, by its Job times environment key: `depot:<label>` and the like for providers,
 * plain `container` for the Cloudflare Container, and `machine` for `machine:<id>` and
 * `self-hosted:<group>`, the runners people host themselves.
 */
export function providerOfEnvironment(key: string): ProviderId | "machine" {
  if (key === "container") return "cloudflare";
  if (key.startsWith("machine:") || key.startsWith("self-hosted:")) return "machine";
  const id = key.slice(0, key.indexOf(":"));
  return isProviderId(id) ? id : "other";
}
export {
  type GitHubRunner,
  githubRate,
  listRate,
  PRICE_CHANGES,
  PRICES_CHECKED,
  rateText,
} from "./prices.ts";
