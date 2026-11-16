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
  "boat",
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
  boat: "Boat runs each GitHub Actions job in a fresh Linux VM, under your Boat account.",
  "runs-on": "RunsOn starts a runner for each job in your own AWS account.",
  github: "GitHub-hosted runners work in every repository with nothing to set up.",
};

// Where a provider works differently from the rest, in its own words on its page.
interface Quirks {
  /** Shown under its list prices. */
  priceNote?: string;
  /** The answer to "Do public repos run on it?", when it isn't "yes". */
  publicRepos?: string;
  /** Questions only this provider raises. */
  faqs?: { q: string; a: string }[];
}

const QUIRKS: Partial<Record<IntegrationId, Quirks>> = {
  boat: {
    priceNote:
      "CI needs Boat's $20 plan or higher, which comes back as VM time. Starts past the plan's limits cost $0.03 to $0.07 each.",
    publicRepos:
      "Not by default. Boat refuses jobs from public repos until you allow them with boat ci public, and then runs only the people you list.",
    faqs: [
      {
        q: "What happens when I reach Boat's start limits?",
        a: "Each job is one start, and Boat caps starts per minute, hour and day: 12, 60 and 200 on the $20 plan. Past the hour or day limit a job shows Paused by plan limit on GitHub and waits until someone re-runs it. Putting your own machines first in the runner order keeps those starts for when you need them.",
      },
      {
        q: "Which runners does Boat have?",
        a: "Linux x64 only, on Ubuntu 24.04: boat-small (2 vCPU), boat (4 vCPU), boat-large (8 vCPU) and boat-xlarge (16 vCPU, on the $100 plan and up). For macOS, Windows or Arm, put another runner after Boat in your order.",
      },
    ],
  },
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
  quirks: Quirks;
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
    quirks: QUIRKS[id] ?? {},
  };
}

export const INTEGRATIONS = INTEGRATION_IDS.map(integration);

/** Where people suggest a provider we don't support yet: a GitHub issue, or email. */
export const SUGGEST_ISSUE_URL =
  "https://github.com/relayrunner/relayrunner/issues/new?title=Integration%20request%3A%20";
export const SUGGEST_EMAIL = "mailto:feedback@relayrunner.app?subject=Integration%20request";
