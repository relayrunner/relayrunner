// Every runner a priced provider sells, for the Machine prices grid and chart on its provider page:
// one row per system (Linux x64, Linux Arm, Windows, macOS, GPU, or a variant such as
// memory-heavy), each runner with its label, size and list price. Prices come from the price book,
// so rows operators record in D1 show here too; sizes come from runnerSize where the label says.
import type { ProviderId } from "./index.ts";
import {
  GITHUB_LABELS,
  GITHUB_LARGER,
  type GitHubRunner,
  listRate,
  type PriceBook,
  type RunnerPlatform,
  type RunnerSize,
  runnerSize,
} from "./prices.ts";

export type CatalogPlatform = RunnerPlatform | "gpu";

// Each system's name, in the order rows show.
const PLATFORM_NAMES: Record<CatalogPlatform, string> = {
  linux: "Linux x64",
  arm: "Linux Arm",
  windows: "Windows",
  "windows-arm": "Windows Arm",
  macos: "macOS",
  gpu: "GPU",
};

interface Entry {
  /** The runs-on label, or for GitHub the rate (larger runners have no fixed label). */
  label: string;
  /** The label people know it by, when it isn't `label` (GitHub's `ubuntu-latest`). */
  name?: string;
  /** A size runnerSize can't read off the label. */
  size?: RunnerSize;
  /** GitHub's larger runners, which only Team and Enterprise plans can add. */
  larger?: true;
  /** A word on what sets it apart, such as "Intel" or "Windows". */
  note?: string;
}

interface Row {
  platform: CatalogPlatform;
  /** Set when a provider sells two lines on one system, such as BerryBox's memory-heavy. */
  variant?: string;
  runners: Entry[];
}

const sizes = (list: number[], label: (n: number) => string): Entry[] =>
  list.map((n) => ({ label: label(n) }));

const UP_TO_32 = [2, 4, 8, 16, 32];
const UP_TO_64 = [...UP_TO_32, 64];

// GitHub's standard runners, by the rate jobs are priced at. macOS's size differs by image; this
// is the Apple silicon one macos-latest runs on.
const GITHUB_STANDARD: [CatalogPlatform, GitHubRunner, RunnerSize?][] = [
  ["linux", "linux-1-core"],
  ["linux", "linux-2-core"],
  ["arm", "linux-arm-2-core"],
  ["windows", "windows-2-core"],
  ["windows-arm", "windows-arm-2-core"],
  ["macos", "macos", { vcpus: 3, memoryGb: 7 }],
];

// The larger runners with a fixed label, and what sets apart those that share a row and size.
const GITHUB_LARGER_LABELS: Partial<Record<string, string>> = {
  "macos-xl": "macos-latest-xlarge",
  "macos-l": "macos-latest-large",
};
const GITHUB_NOTES: Partial<Record<string, string>> = {
  "macos-xl": "M2 Pro",
  "macos-l": "Intel",
  "linux-4-core-gpu": "Linux",
  "windows-4-core-gpu": "Windows",
};

/** GitHub's runners by system: the standard one or two, then the larger ones. */
const githubRows = (): Row[] =>
  (Object.keys(PLATFORM_NAMES) as CatalogPlatform[]).map((platform) => ({
    platform,
    runners: [
      ...GITHUB_STANDARD.filter((runner) => runner[0] === platform).map(([, rate, size]) => ({
        label: rate,
        name: rate === "macos" ? "macos-latest" : GITHUB_LABELS[rate],
        size,
      })),
      ...GITHUB_LARGER.filter((runner) => runner.platform === platform).map((runner) => ({
        label: runner.rate,
        name: GITHUB_LARGER_LABELS[runner.rate],
        size: runner.size,
        larger: true as const,
        note: GITHUB_NOTES[runner.rate],
      })),
    ],
  }));

const CATALOG: Partial<Record<ProviderId, Row[]>> = {
  // https://docs.github.com/en/billing/reference/actions-runner-pricing
  github: githubRows(),
  // https://docs.blacksmith.sh/blacksmith-runners/overview
  blacksmith: [
    { platform: "linux", runners: sizes(UP_TO_32, (n) => `blacksmith-${n}vcpu-ubuntu-2404`) },
    { platform: "arm", runners: sizes(UP_TO_32, (n) => `blacksmith-${n}vcpu-ubuntu-2404-arm`) },
    { platform: "windows", runners: sizes(UP_TO_32, (n) => `blacksmith-${n}vcpu-windows-2025`) },
    { platform: "macos", runners: sizes([6, 12], (n) => `blacksmith-${n}vcpu-macos-latest`) },
  ],
  // https://depot.dev/docs/github-actions/runner-types
  depot: [
    { platform: "linux", runners: sizes(UP_TO_64, (n) => depotLabel("ubuntu-24.04", n)) },
    { platform: "arm", runners: sizes(UP_TO_64, (n) => depotLabel("ubuntu-24.04-arm", n)) },
    { platform: "windows", runners: sizes(UP_TO_64, (n) => depotLabel("windows-2025", n)) },
    {
      platform: "macos",
      runners: [{ label: "depot-macos-latest", size: { vcpus: 8, memoryGb: 24 } }],
    },
  ],
  // https://www.warpbuild.com/pricing.json (Arm "xfast" runners are a separate line, left out)
  warpbuild: [
    { platform: "linux", runners: sizes(UP_TO_32, (n) => `warp-ubuntu-latest-x64-${n}x`) },
    { platform: "arm", runners: sizes(UP_TO_32, (n) => `warp-ubuntu-latest-arm64-${n}x`) },
    { platform: "windows", runners: sizes([4, 8, 16, 32], (n) => `warp-windows-latest-x64-${n}x`) },
    { platform: "macos", runners: sizes([6, 12], (n) => `warp-macos-latest-arm64-${n}x`) },
  ],
  // https://www.ubicloud.com/docs/github-actions-integration/runner-types (premium runners take
  // jobs on their own when free, so they're not a separate choice)
  ubicloud: [
    { platform: "linux", runners: sizes([2, 4, 8, 16, 30], (n) => `ubicloud-standard-${n}`) },
    { platform: "arm", runners: sizes([2, 4, 8, 16, 30], (n) => `ubicloud-standard-${n}-arm`) },
  ],
  // https://docs.boat.dev/machines
  boat: [
    {
      platform: "linux",
      runners: ["boat-small", "boat", "boat-large", "boat-xlarge"].map((label) => ({ label })),
    },
  ],
  // https://starsling.dev/pricing
  starsling: [
    { platform: "linux", runners: sizes(UP_TO_64, (n) => `starsling-ubuntu-24.04-${n}`) },
  ],
  // https://monkci.com/pricing
  monkci: [{ platform: "linux", runners: sizes(UP_TO_32, (n) => `monkci-ubuntu-24.04-${n}`) }],
  // https://runloft.dev/pricing/
  runloft: [
    { platform: "linux", runners: sizes(UP_TO_32, (n) => runloftLabel("ubuntu-24.04", n)) },
    { platform: "arm", runners: sizes(UP_TO_32, (n) => runloftLabel("ubuntu-24.04-arm", n)) },
    { platform: "windows", runners: sizes(UP_TO_32, (n) => `runloft-windows-2025-${n}cpu`) },
    {
      platform: "macos",
      runners: [{ label: "runloft-macos-15", size: { vcpus: 6, memoryGb: 24 } }],
    },
  ],
  // https://docs.berrybox.io/docs/teams-and-billing/billing
  berrybox: [
    { platform: "linux", runners: sizes([2, 4, 8, 16], (n) => `berrybox-${n}vcpu-ubuntu-2404`) },
    {
      platform: "linux",
      variant: "Memory-heavy",
      runners: sizes([2, 4, 8, 16], (n) => `berrybox-memory-${n}vcpu-ubuntu-2404`),
    },
  ],
  latchkey: [
    {
      platform: "linux",
      runners: ["small", "medium", "large", "xlarge"].map((size) => ({
        label: `latchkey-${size}`,
      })),
    },
  ],
  celesto: [
    {
      platform: "linux",
      runners: ["micro", "standard", "large", "xl"].map((size) => ({ label: `celesto-${size}` })),
    },
    {
      platform: "linux",
      variant: "More memory",
      runners: [{ label: "celesto-small" }, { label: "celesto-memory" }],
    },
  ],
  instabox: [
    {
      platform: "linux",
      runners: ["small", "medium", "large", "xlarge", "2xlarge"].map((size) => ({
        label: `instabox-${size}`,
      })),
    },
  ],
  lizard: [
    {
      platform: "linux",
      runners: ["small", "medium", "large"].map((size) => ({
        label: `lizard-${size}-ubuntu-2404`,
      })),
    },
  ],
  // https://groundbox.dev/pricing (flex runners wait for spare room, at half price)
  groundbox: [
    { platform: "linux", runners: sizes([2, 4, 8, 16], (n) => `groundbox-${n}vcpu`) },
    {
      platform: "linux",
      variant: "Flex",
      runners: sizes([2, 4, 8, 16], (n) => `groundbox-flex-${n}vcpu`),
    },
  ],
};

function depotLabel(image: string, n: number) {
  return n === 2 ? `depot-${image}` : `depot-${image}-${n}`;
}

function runloftLabel(image: string, n: number) {
  return n === 2 ? `runloft-${image}` : `runloft-${image}-${n}cpu`;
}

export interface CatalogRunner {
  /** The runs-on label, or for GitHub the rate, the key a provider report's runner goes by. */
  label: string;
  /** What to call it: its label, or the name GitHub's docs give it. Null for a larger runner. */
  name: string | null;
  size: RunnerSize | null;
  /** USD a minute at list price, or null when the book has no price for it. */
  usd: number | null;
  larger: boolean;
  note: string | null;
}

export interface CatalogRow {
  platform: CatalogPlatform;
  /** "Linux x64", or "Linux x64 · Memory-heavy" for a provider's second line on one system. */
  name: string;
  runners: CatalogRunner[];
}

/** A provider's runners by system, priced at `at` (now by default). Empty when it has none listed. */
export function runnerCatalog(book: PriceBook, provider: string, at = Date.now()): CatalogRow[] {
  const rows = CATALOG[provider as ProviderId] ?? [];
  return rows.map(({ platform, variant, runners }) => ({
    platform,
    name: variant ? `${PLATFORM_NAMES[platform]} · ${variant}` : PLATFORM_NAMES[platform],
    runners: runners.map((entry) => ({
      label: entry.label,
      name: provider === "github" ? (entry.name ?? null) : entry.label,
      size: entry.size ?? runnerSize(provider, entry.label),
      usd:
        provider === "github"
          ? book.usd("github", entry.label, at)
          : listRate(book, provider as ProviderId, entry.label, at),
      larger: entry.larger ?? false,
      note: entry.note ?? null,
    })),
  }));
}
