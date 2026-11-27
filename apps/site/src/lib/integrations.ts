// The integration pages (src/pages/integrations/): one per place a relay can send a job, built from
// @relayrunner/providers so they say what the dashboard says. The header, footer and llms.txt link
// them from this list.
import {
  BASE_BOOK,
  BILLING_PROVIDERS,
  HOSTED_PROVIDER_IDS,
  isBillingProvider,
  dayMs,
  nextPrice,
  priceAt,
  PROVIDERS,
  rateName,
  ratePrices,
  rateText,
  type BillingProviderInfo,
  type ProviderId,
} from "@relayrunner/providers";

/** The runner clouds added on 2026-11-17, named here so their pages exist whichever list holds them. */
export const NEWER_CLOUD_IDS = [
  "starsling",
  "monkci",
  "runloft",
  "latchkey",
  "berrybox",
  "celesto",
  "instabox",
] as const satisfies readonly ProviderId[];

export const INTEGRATION_IDS = [
  ...new Set([...HOSTED_PROVIDER_IDS, ...NEWER_CLOUD_IDS, "github"] as const),
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
  starsling:
    "StarSling runs GitHub Actions jobs on its own machines, under your StarSling account.",
  monkci: "Monk CI runs GitHub Actions jobs on its own machines, under your Monk CI account.",
  runloft: "Runloft runs GitHub Actions jobs on its own machines, under your Runloft account.",
  latchkey: "Latchkey runs GitHub Actions jobs on its own machines, under your Latchkey account.",
  berrybox: "BerryBox runs GitHub Actions jobs on its own machines, under your BerryBox account.",
  celesto: "Celesto runs GitHub Actions jobs on its own machines, under your Celesto account.",
  instabox: "InstaBox runs GitHub Actions jobs on its own machines, under your InstaBox account.",
  lizard:
    "Lizard runs each GitHub Actions job in its own Firecracker VM, under your Lizard account.",
  groundbox:
    "Groundbox runs each GitHub Actions job in a fresh single-use VM, under your Groundbox account.",
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

/** A question for the runner clouds that only take jobs from GitHub organizations. */
const orgsOnly = (name: string) => ({
  q: `Can I use ${name} with a personal GitHub account?`,
  a: `No. ${name} only runs jobs for repositories owned by a GitHub organization. Jobs from a personal account's repos go to the next runner in your order.`,
});

const QUIRKS: Partial<Record<IntegrationId, Quirks>> = {
  starsling: { faqs: [orgsOnly("StarSling")] },
  monkci: { faqs: [orgsOnly("Monk CI")] },
  latchkey: { faqs: [orgsOnly("Latchkey")] },
  lizard: {
    faqs: [
      orgsOnly("Lizard"),
      {
        q: "What happens when Lizard's trial jobs run out?",
        a: "The trial runs 50 small, 20 medium and 10 large jobs. Once a size's jobs are used, Lizard skips jobs of that size until you start Pro. On Pro, usage past the plan's included amount is billed as you go, and jobs past its 5 at once wait in Lizard's queue.",
      },
    ],
  },
  groundbox: {
    faqs: [
      {
        q: "What size does the groundbox label get?",
        a: "A job on the bare groundbox label gets a size Groundbox picks from the job's earlier runs, from 2 to 16 vCPU. A job with no history starts at 4 vCPU, and the default most is 8. It's billed at the size it ran at, so the dashboard can't price it from the label. To pin a size, use a label such as groundbox-4vcpu.",
      },
      {
        q: "What are Groundbox's flex runners?",
        a: "groundbox-flex and groundbox-flex-2vcpu through -16vcpu are the same sizes at half price. They only run in Groundbox's spare room, so a job on one may wait before it starts.",
      },
      {
        q: "Does Groundbox run Windows jobs?",
        a: "Yes: runs-on groundbox-windows-2vcpu, -4vcpu, -8vcpu or -16vcpu (bare groundbox-windows is 4 vCPU) gets a fresh Windows Server 2025 Datacenter VM per job, with 4 GB of memory a vCPU. It's $0.006, $0.012, $0.022 and $0.042 a minute, billed per second, and boot time isn't billed. On the free plan a Windows minute uses free minutes at 2x its size.",
      },
      {
        q: "Does Groundbox run macOS jobs?",
        a: "Yes: runs-on groundbox-macos gets a fresh macOS VM per job, 12 vCPU on Apple silicon M6 with 12 GB of memory, macOS 26 Tahoe and Xcode 27.2. It's $0.05 a minute, billed per second. On the free plan a macOS minute uses 15 free minutes.",
      },
    ],
  },
  runloft: {
    faqs: [
      {
        q: "Which runners does Runloft have?",
        a: "Every account starts with 2 vCPU Linux x64 runners. Larger sizes, Arm, Windows and macOS runners are turned on per account when you ask Runloft.",
      },
    ],
  },
  instabox: {
    faqs: [
      {
        q: "Which runners does InstaBox's free plan run?",
        a: "Only instabox-medium (4 vCPU). Other sizes need a paid plan, and InstaBox leaves jobs for them queued until you have one.",
      },
    ],
  },
  berrybox: {
    publicRepos:
      "No. BerryBox only runs jobs from private repositories, so a public repo's jobs go to the next runner in your order.",
    faqs: [orgsOnly("BerryBox")],
  },
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
  /**
   * Each rate's list price on the day the site was built, such as { name: "Linux", price:
   * "$0.004/min per vCPU" }, and the next announced one, such as "$0.005/min per vCPU from Dec 1, 2026".
   */
  prices: { name: string; price: string; next?: string }[];
  /** How to connect its billing, for the providers whose real spend the dashboard can read. */
  billing?: BillingProviderInfo;
  quirks: Quirks;
}

const dayText = (day: string) =>
  new Date(dayMs(day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

export function integration(id: IntegrationId): Integration {
  const { name, summary, labels, example, setup, docsUrl, dashboardUrl } = PROVIDERS[id];
  // The page is built ahead of time, so it shows the price on the day it was built and says when
  // a price that's already announced takes over, rather than showing that one early.
  const prices = ratePrices(BASE_BOOK, id).flatMap(({ rate, per, history }) => {
    const today = priceAt(history);
    if (!today) return [];
    const text = (usd: number) => `${rateText(usd)}${per === "vcpu" ? " per vCPU" : ""}`;
    const next = nextPrice(history);
    return [
      {
        name: rateName(rate),
        price: text(today.usd),
        next: next && `${text(next.usd)} from ${dayText(next.from)}`,
      },
    ];
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
