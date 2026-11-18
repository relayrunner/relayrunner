// The runner table on /integrations: each hosted provider's list price for one runner, by platform
// and size, with its cheapest plan for real CI. Prices and plans come from @relayrunner/providers,
// the same list the dashboard's Providers page reads.
import {
  BASE_BOOK,
  LISTED_PROVIDER_IDS,
  type ListedProviderId,
  listRate,
  providerPlans,
  PROVIDERS,
  startsAt,
  type ProviderId,
} from "@relayrunner/providers";
import { integrationPath, type IntegrationId } from "./integrations";

export const TABLE_PLATFORMS = [
  { id: "linux", label: "Linux x64" },
  { id: "arm", label: "Linux Arm" },
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
] as const;
export type TablePlatform = (typeof TABLE_PLATFORMS)[number]["id"];

/** The sizes the table offers, in vCPUs. macOS runners come in one size each, so it has none. */
export const TABLE_SIZES = [2, 4, 8, 16] as const;
export type TableSize = (typeof TABLE_SIZES)[number];

/** The runner a provider sells for a platform and size: its label and vCPUs. */
interface Runner {
  label: string;
  vcpus: number;
}

type RunnerOf = (platform: TablePlatform, vcpus: TableSize) => Runner | null;

const sized = (label: string, vcpus: number): Runner => ({ label, vcpus });

// The label each provider uses for a platform and size, or null when it sells no such runner.
const RUNNERS: Partial<Record<ProviderId, RunnerOf>> = {
  blacksmith: (platform, n) =>
    ({
      linux: sized(`blacksmith-${n}vcpu-ubuntu-2404`, n),
      arm: sized(`blacksmith-${n}vcpu-ubuntu-2404-arm`, n),
      windows: sized(`blacksmith-${n}vcpu-windows-2025`, n),
      macos: sized("blacksmith-6vcpu-macos-latest", 6),
    })[platform],
  depot: (platform, n) => {
    const size = n === 2 ? "" : `-${n}`;
    return {
      linux: sized(`depot-ubuntu-24.04${size}`, n),
      arm: sized(`depot-ubuntu-24.04-arm${size}`, n),
      windows: sized(`depot-windows-2025${size}`, n),
      macos: sized("depot-macos-15", 8),
    }[platform];
  },
  warpbuild: (platform, n) =>
    ({
      linux: sized(`warp-ubuntu-latest-x64-${n}x`, n),
      arm: sized(`warp-ubuntu-latest-arm64-${n}x`, n),
      // WarpBuild's Windows runners start at 4 vCPU.
      windows: n >= 4 ? sized(`warp-windows-latest-x64-${n}x`, n) : null,
      macos: sized("warp-macos-latest-arm64-6x", 6),
    })[platform],
  ubicloud: (platform, n) =>
    ({
      linux: sized(`ubicloud-standard-${n}`, n),
      arm: sized(`ubicloud-standard-${n}-arm`, n),
      windows: null,
      macos: null,
    })[platform],
  boat: (platform, n) =>
    platform === "linux"
      ? sized({ 2: "boat-small", 4: "boat", 8: "boat-large", 16: "boat-xlarge" }[n], n)
      : null,
  // GitHub's standard runners. Bigger ones are larger runners, which aren't in the price list.
  github: (platform, n) =>
    n === 2 || platform === "macos"
      ? {
          linux: sized("ubuntu-latest", 2),
          arm: sized("ubuntu-24.04-arm", 2),
          windows: sized("windows-latest", 2),
          macos: sized("macos-latest", 3),
        }[platform]
      : null,
};

// The runner clouds RelayRunner lists but doesn't route to yet (LISTED_PROVIDER_IDS).
const linuxOnly =
  (label: (n: TableSize) => string | null): RunnerOf =>
  (platform, n) => {
    const name = platform === "linux" ? label(n) : null;
    return name ? sized(name, n) : null;
  };
const LISTED_RUNNERS: Record<ListedProviderId, RunnerOf> = {
  starsling: linuxOnly((n) => `starsling-ubuntu-24.04-${n}`),
  monkci: linuxOnly((n) => `monkci-ubuntu-24.04-${n}`),
  // Arm and Windows are turned on per account on request; macOS is too, and it isn't sized by vCPU.
  runloft: (platform, n) => {
    const size = n === 2 ? "" : `-${n}cpu`;
    return (
      {
        linux: sized(`runloft-ubuntu-24.04${size}`, n),
        arm: sized(`runloft-ubuntu-24.04-arm${size}`, n),
        windows: sized(`runloft-windows-2025-${n}cpu`, n),
        macos: null,
      }[platform] ?? null
    );
  },
  latchkey: linuxOnly(
    (n) =>
      ({ 2: "latchkey-small", 4: "latchkey-medium", 8: "latchkey-large", 16: "latchkey-xlarge" })[
        n
      ],
  ),
  berrybox: linuxOnly((n) => `berrybox-${n}vcpu-ubuntu-2404`),
  celesto: linuxOnly(
    (n) => ({ 2: "celesto-standard", 4: "celesto-large", 8: "celesto-xl" })[n as 2 | 4 | 8] ?? null,
  ),
  instabox: linuxOnly(
    (n) =>
      ({ 2: "instabox-small", 4: "instabox-medium", 8: "instabox-large", 16: "instabox-xlarge" })[
        n
      ],
  ),
};

// GitHub's runners are priced by rate, not by label.
const GITHUB_RATES: Record<TablePlatform, string> = {
  linux: "linux-2-core",
  arm: "linux-arm-2-core",
  windows: "windows-2-core",
  macos: "macos",
};

function perMinute(id: ProviderId, platform: TablePlatform, label: string): number | null {
  if (id === "github") return BASE_BOOK.usd("github", GITHUB_RATES[platform], Date.now());
  return listRate(BASE_BOOK, id, label);
}

/** "3,000 min a month" as "3,000 min/mo" and "$20 a month" as "$20/mo", for the featured strip. */
const shortIncluded = (text: string) =>
  text.replace(" min a month", " min/mo").replace(" a month", "/mo");

/**
 * A plan's allowance as the table words it: Linux minutes when the plan is a dollar amount of
 * runner time (GitHub's "$12 a month, about 2,000 Linux min" is "2,000 min a month"), and a
 * pay-as-you-go credit in dollars ("$2.50 credit a month" is "$2.50 a month").
 */
export const includedText = (text: string) =>
  text
    .replace(/^\$[\d.,]+ a month, about ([\d,]+) Linux min$/, "$1 min a month")
    .replace(" credit", "");

/** A provider's cheapest plan for real CI, trials and one-machine free tiers left out. */
function entryPlan(id: ProviderId) {
  const plans = providerPlans(id);
  if (!plans) return null;
  const plan = plans.plans.find((each) => !each.trial) ?? plans.plans[0]!;
  return {
    // GitHub's minutes come with a GitHub plan; you don't buy one for CI.
    plan: id === "github" ? "With your GitHub plan" : startsAt(plans),
    included: includedText(plan.included),
  };
}

export interface TableRow {
  id: ProviderId;
  name: string;
  href: string;
  /** A runner cloud RelayRunner lists but can't route jobs to yet; its link goes to its own site. */
  soon: boolean;
  logo: string;
  plan: string;
  included: string;
  /** The runner and its price for each platform and size, keyed `linux-2`, `macos`. */
  cells: Record<string, { label: string; vcpus: number; usd: number }>;
}

/** The key a row's cell for one platform and size goes by. */
export const cellKey = (platform: TablePlatform, vcpus: TableSize) =>
  platform === "macos" ? "macos" : `${platform}-${vcpus}`;

/** The providers the table prices, in this order. Namespace and RunsOn get a line of their own. */
const PRICED: ProviderId[] = ["blacksmith", "boat", "depot", "github", "ubicloud", "warpbuild"];

const row = (id: ProviderId, runnerOf: RunnerOf, soon: boolean): TableRow => {
  const cells: TableRow["cells"] = {};
  for (const { id: platform } of TABLE_PLATFORMS) {
    for (const size of platform === "macos" ? ([2] as const) : TABLE_SIZES) {
      const runner = runnerOf(platform, size);
      const usd = runner && perMinute(id, platform, runner.label);
      if (runner && usd) cells[cellKey(platform, size)] = { ...runner, usd };
    }
  }
  const entry = entryPlan(id);
  return {
    id,
    name: PROVIDERS[id].name,
    href: soon
      ? (providerPlans(id)?.source ?? PROVIDERS[id].docsUrl ?? "#")
      : `${integrationPath(id as IntegrationId)}#details`,
    soon,
    logo: `/providers/${id}.svg`,
    plan: entry?.plan ?? "—",
    included: entry?.included ?? "—",
    cells,
  };
};

/** The providers you can route to first, then the runner clouds that are coming, each by name. */
export const TABLE_ROWS: TableRow[] = [
  ...PRICED.map((id) => row(id, RUNNERS[id]!, false)),
  ...[...LISTED_PROVIDER_IDS]
    .sort((a, b) => PROVIDERS[a].name.localeCompare(PROVIDERS[b].name))
    .map((id) => row(id, LISTED_RUNNERS[id], true)),
];

/** Why a row has no runner for a platform and size: "No Windows runners", "Windows from 4 vCPU". */
export function missingText(row: TableRow, platform: TablePlatform, size: TableSize): string {
  const name = TABLE_PLATFORMS.find((each) => each.id === platform)!.label;
  const sizes = TABLE_SIZES.filter((each) => row.cells[cellKey(platform, each)]);
  if (row.id === "runloft" && platform === "macos") return "macOS on request";
  if (sizes.length === 0) return `No ${name} runners`;
  if (row.id === "github") return "Larger GitHub runners aren't in the price list";
  return size < sizes[0]! ? `${name} from ${sizes[0]} vCPU` : `${name} up to ${sizes.at(-1)} vCPU`;
}

/** Each row's line for every platform and size it has no runner for, keyed as its cells are. */
export const missingLines = (row: TableRow) =>
  Object.fromEntries(
    TABLE_PLATFORMS.flatMap(({ id: platform }) =>
      (platform === "macos" ? ([2] as const) : TABLE_SIZES)
        .filter((size) => !row.cells[cellKey(platform, size)])
        .map((size) => [cellKey(platform, size), missingText(row, platform, size)]),
    ),
  );

/** Providers the table can't price per runner, and why. */
export const UNPRICED_ROWS: { id: IntegrationId; why: string }[] = [
  { id: "namespace", why: "Priced by runner profile" },
  { id: "runs-on", why: "Runs in your own AWS account" },
].map((row) => ({ ...row, id: row.id as IntegrationId }));

/** The runner clouds the strip above the table features. */
export const FEATURED: IntegrationId[] = ["blacksmith", "depot", "boat", "github"];

export const FEATURED_TILES = FEATURED.map((id) => {
  const entry = entryPlan(id);
  return {
    id,
    name: PROVIDERS[id].name,
    href: `${integrationPath(id)}#details`,
    logo: `/providers/${id}.svg`,
    plan: id === "github" ? "Free with GitHub" : (entry?.plan ?? "—"),
    included: entry ? shortIncluded(entry.included) : "—",
  };
});

/** "$0.004", "$0.0003": a minute's price without trailing zeros. */
export const minuteText = (usd: number) => `$${Number(usd.toFixed(5))}`;

/** "$0.24": an hour's price, to the cent. */
export const hourText = (usd: number) => `$${(usd * 60).toFixed(2)}`;
