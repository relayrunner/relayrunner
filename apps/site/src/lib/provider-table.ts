// The runner table on /integrations: each hosted provider's list price for one runner, by platform
// and size, with its cheapest plan for real CI. Prices and plans come from @relayrunner/providers,
// the same list the dashboard's Providers page reads.
import {
  BASE_BOOK,
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
const RUNNERS: Partial<Record<IntegrationId, RunnerOf>> = {
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

// GitHub's runners are priced by rate, not by label.
const GITHUB_RATES: Record<TablePlatform, string> = {
  linux: "linux-2-core",
  arm: "linux-arm-2-core",
  windows: "windows-2-core",
  macos: "macos",
};

function perMinute(id: IntegrationId, platform: TablePlatform, label: string): number | null {
  if (id === "github") return BASE_BOOK.usd("github", GITHUB_RATES[platform], Date.now());
  return listRate(BASE_BOOK, id as ProviderId, label);
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
function entryPlan(id: IntegrationId) {
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
  id: IntegrationId;
  name: string;
  href: string;
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
const PRICED: IntegrationId[] = ["blacksmith", "boat", "depot", "github", "ubicloud", "warpbuild"];

export const TABLE_ROWS: TableRow[] = PRICED.map((id) => {
  const runnerOf = RUNNERS[id]!;
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
    href: integrationPath(id),
    logo: `/providers/${id}.svg`,
    plan: entry?.plan ?? "—",
    included: entry?.included ?? "—",
    cells,
  };
});

/** Why a row has no runner for a platform and size: "No Windows runners", "Windows from 4 vCPU". */
export function missingText(row: TableRow, platform: TablePlatform): string {
  const name = TABLE_PLATFORMS.find((each) => each.id === platform)!.label;
  const sizes = TABLE_SIZES.filter((size) => row.cells[cellKey(platform, size)]);
  if (sizes.length === 0) return `No ${name} runners`;
  if (row.id === "github") return "Larger GitHub runners aren't in the price list";
  return `${name} from ${sizes[0]} vCPU`;
}

/** Each row's line for every platform and size it has no runner for, keyed as its cells are. */
export const missingLines = (row: TableRow) =>
  Object.fromEntries(
    TABLE_PLATFORMS.flatMap(({ id: platform }) =>
      (platform === "macos" ? ([2] as const) : TABLE_SIZES)
        .filter((size) => !row.cells[cellKey(platform, size)])
        .map((size) => [cellKey(platform, size), missingText(row, platform)]),
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
    href: integrationPath(id),
    logo: `/providers/${id}.svg`,
    plan: id === "github" ? "Free with GitHub" : (entry?.plan ?? "—"),
    included: entry ? shortIncluded(entry.included) : "—",
  };
});

/** "$0.004", "$0.0003": a minute's price without trailing zeros. */
export const minuteText = (usd: number) => `$${Number(usd.toFixed(5))}`;

/** "$0.24": an hour's price, to the cent. */
export const hourText = (usd: number) => `$${(usd * 60).toFixed(2)}`;
