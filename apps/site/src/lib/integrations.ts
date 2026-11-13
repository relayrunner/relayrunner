// The integration pages (src/pages/integrations/): one per place a relay can send a job, built from
// @relayrunner/providers so they say what the dashboard says. The header, footer and llms.txt link
// them from this list.
import {
  BASE_BOOK,
  BILLING_PROVIDERS,
  HOSTED_PROVIDER_IDS,
  isBillingProvider,
  PROVIDERS,
  rateName,
  ratePrices,
  rateText,
  type BillingProviderInfo,
  type ProviderId,
} from "@relayrunner/providers";

export const INTEGRATION_IDS = [
  ...HOSTED_PROVIDER_IDS,
  "github",
] as const satisfies readonly ProviderId[];

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export const integrationPath = (id: IntegrationId) => `/integrations/${id}`;

// The first line under each page's headline: who runs the job and where.
const INTROS: Record<IntegrationId, string> = {
  blacksmith:
    "Blacksmith runs GitHub Actions jobs on its own machines, under your Blacksmith account.",
  depot: "Depot runs GitHub Actions jobs on its own machines, under your Depot account.",
  namespace:
    "Namespace runs GitHub Actions jobs on runners sized by profile, under your Namespace account.",
  warpbuild:
    "WarpBuild runs GitHub Actions jobs on its own machines, under your WarpBuild account.",
  ubicloud: "Ubicloud runs GitHub Actions jobs on its own machines, under your Ubicloud account.",
  "runs-on": "RunsOn starts a runner for each job in your own AWS account.",
  github: "GitHub-hosted runners work in every repository with nothing to set up.",
};

export interface Integration {
  id: IntegrationId;
  name: string;
  summary: string;
  intro: string;
  labels: string;
  example: string;
  setup: string;
  docsUrl?: string;
  dashboardUrl?: string;
  /** The latest list price of each rate, such as { name: "Linux", price: "$0.004/min per vCPU" }. */
  prices: { name: string; price: string }[];
  /** How to connect its billing, for the providers whose real spend the dashboard can read. */
  billing?: BillingProviderInfo;
}

export function integration(id: IntegrationId): Integration {
  const { name, summary, labels, example, setup, docsUrl, dashboardUrl } = PROVIDERS[id];
  const prices = ratePrices(BASE_BOOK, id).flatMap(({ rate, per, history }) => {
    const latest = history.at(-1);
    if (!latest) return [];
    const price = rateText(latest.usd);
    return [{ name: rateName(rate), price: per === "vcpu" ? `${price} per vCPU` : price }];
  });
  return {
    id,
    name,
    summary,
    intro: INTROS[id],
    labels,
    example: example!,
    setup: setup!,
    docsUrl,
    dashboardUrl,
    prices,
    billing: isBillingProvider(id) ? BILLING_PROVIDERS[id] : undefined,
  };
}

export const INTEGRATIONS = INTEGRATION_IDS.map(integration);

/** Where people suggest a provider we don't support yet: a GitHub issue, or email. */
export const SUGGEST_ISSUE_URL =
  "https://github.com/relayrunner/relayrunner/issues/new?title=Integration%20request%3A%20";
export const SUGGEST_EMAIL = "mailto:feedback@relayrunner.app?subject=Integration%20request";
