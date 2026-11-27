// List prices for hosted runners, in USD, read from each service's public price page. They are
// estimates: RelayRunner never sees the bill, so plan allowances, credits and discounts are left
// out.
//
// Code says how prices are shaped: which rates a provider has and how a runner label turns into
// one (a size times a per-vCPU rate, say). The numbers are dated price rows. The rows below are
// the base list; the API adds rows operators record in D1 on top, so a price change needs no
// deploy. A change is a new row from the day it took effect, and old rows stay, so a job is always
// priced at what a minute cost on the day it ran.
import type { ProviderId } from "./index.ts";

/** When the base prices below were last checked against the services' pages. */
export const PRICES_CHECKED = "2026-11-11";

/** The systems runners come in, for comparing runners across providers. */
export type RunnerPlatform = "linux" | "arm" | "windows" | "windows-arm" | "macos";

/** A GitHub larger runner: what it's called, its billing SKU, size and list price. */
export interface GitHubLargerRunner {
  rate: string;
  sku: string;
  name: string;
  platform: RunnerPlatform | "gpu";
  size: RunnerSize;
  usd: number;
}

// Linux and Windows larger runners: 4 GB a core.
const coreLadder = (os: "linux" | "windows", arm: boolean, prices: [number, number][]) =>
  prices.map(([cores, usd]): GitHubLargerRunner => ({
    rate: `${os}${arm ? "-arm" : ""}-${cores}-core`,
    sku: `${os}_${cores}_core${arm ? "_arm" : ""}`,
    name: `${os === "linux" ? "Linux" : "Windows"}${arm ? " Arm" : ""} ${cores}-core`,
    platform: os === "linux" ? (arm ? "arm" : "linux") : arm ? "windows-arm" : "windows",
    size: { vcpus: cores, memoryGb: cores * 4 },
    usd,
  }));

/**
 * GitHub's larger runners, for Team and Enterprise plans. Each is named by the org that makes it, so
 * jobs can't be matched to one by label; they price the catalog on the GitHub provider page.
 * https://docs.github.com/en/billing/reference/actions-runner-pricing (checked 2026-11-20)
 */
export const GITHUB_LARGER: GitHubLargerRunner[] = [
  ...coreLadder("linux", false, [
    [4, 0.012],
    [8, 0.022],
    [16, 0.042],
    [32, 0.082],
    [64, 0.162],
    [96, 0.252],
  ]),
  ...coreLadder("linux", true, [
    [4, 0.008],
    [8, 0.014],
    [16, 0.026],
    [32, 0.05],
    [64, 0.098],
  ]),
  ...coreLadder("windows", false, [
    [4, 0.022],
    [8, 0.042],
    [16, 0.082],
    [32, 0.162],
    [64, 0.322],
    [96, 0.552],
  ]),
  ...coreLadder("windows", true, [
    [4, 0.014],
    [8, 0.026],
    [16, 0.05],
    [32, 0.098],
    [64, 0.194],
  ]),
  {
    rate: "macos-xl",
    sku: "macos_xl",
    name: "macOS M2 Pro",
    platform: "macos",
    size: { vcpus: 5, memoryGb: 14 },
    usd: 0.102,
  },
  {
    rate: "macos-l",
    sku: "macos_l",
    name: "macOS 12-core Intel",
    platform: "macos",
    size: { vcpus: 12, memoryGb: 30 },
    usd: 0.077,
  },
  {
    rate: "linux-4-core-gpu",
    sku: "linux_4_core_gpu",
    name: "Linux GPU 4-core",
    platform: "gpu",
    size: { vcpus: 4, memoryGb: 28 },
    usd: 0.052,
  },
  {
    rate: "windows-4-core-gpu",
    sku: "windows_4_core_gpu",
    name: "Windows GPU 4-core",
    platform: "gpu",
    size: { vcpus: 4, memoryGb: 28 },
    usd: 0.102,
  },
];

/** A provider's rates, and what one minute of each is per. */
export const RATES = {
  blacksmith: { linux: "vcpu", arm: "vcpu", windows: "vcpu", macos: "vcpu" },
  depot: { linux: "vcpu", arm: "vcpu", windows: "vcpu", macos: "vcpu" },
  warpbuild: { linux: "vcpu", arm: "vcpu", windows: "vcpu", macos: "vcpu" },
  ubicloud: { standard: "vcpu", premium: "vcpu" },
  // Per runner, by label: boat-xlarge costs more per vCPU than the other sizes.
  boat: { "boat-small": "runner", boat: "runner", "boat-large": "runner", "boat-xlarge": "runner" },
  // Runner clouds added 2026-11-17.
  starsling: { linux: "vcpu" },
  monkci: { linux: "vcpu" },
  runloft: { linux: "vcpu", arm: "vcpu", windows: "vcpu", macos: "runner" },
  berrybox: { linux: "vcpu", memory: "vcpu" },
  // Per runner, by size name: their labels name a size, not a vCPU count.
  latchkey: {
    "latchkey-small": "runner",
    "latchkey-medium": "runner",
    "latchkey-large": "runner",
    "latchkey-xlarge": "runner",
  },
  celesto: {
    "celesto-micro": "runner",
    "celesto-small": "runner",
    "celesto-standard": "runner",
    "celesto-memory": "runner",
    "celesto-large": "runner",
    "celesto-xl": "runner",
  },
  instabox: {
    "instabox-small": "runner",
    "instabox-medium": "runner",
    "instabox-large": "runner",
    "instabox-xlarge": "runner",
    "instabox-2xlarge": "runner",
  },
  lizard: {
    "lizard-small": "runner",
    "lizard-medium": "runner",
    "lizard-large": "runner",
  },
  groundbox: {
    "groundbox-2vcpu": "runner",
    "groundbox-4vcpu": "runner",
    "groundbox-8vcpu": "runner",
    "groundbox-16vcpu": "runner",
    "groundbox-flex-2vcpu": "runner",
    "groundbox-flex-4vcpu": "runner",
    "groundbox-flex-8vcpu": "runner",
    "groundbox-flex-16vcpu": "runner",
    macos: "runner",
    "groundbox-windows-2vcpu": "runner",
    "groundbox-windows-4vcpu": "runner",
    "groundbox-windows-8vcpu": "runner",
    "groundbox-windows-16vcpu": "runner",
  },
  github: {
    "linux-1-core": "runner",
    "linux-2-core": "runner",
    "linux-arm-2-core": "runner",
    "windows-2-core": "runner",
    "windows-arm-2-core": "runner",
    macos: "runner",
    ...Object.fromEntries(GITHUB_LARGER.map(({ rate }) => [rate, "runner" as const])),
  },
} as const satisfies Partial<Record<ProviderId, Record<string, "vcpu" | "runner">>>;

export type PricedProvider = keyof typeof RATES;

/** GitHub's standard hosted runners, the ones jobs name by a fixed label. */
export type GitHubRunner =
  | "linux-1-core"
  | "linux-2-core"
  | "linux-arm-2-core"
  | "windows-2-core"
  | "windows-arm-2-core"
  | "macos";

/**
 * The `runs-on` label GitHub's docs give each standard runner, the name people know it by. Where
 * one runner has several labels (`ubuntu-latest`, `ubuntu-24.04`), this is the first one listed.
 * macOS has none: one rate covers several images (`macos-latest`, `macos-15-intel`), so it stays
 * "macOS". https://docs.github.com/en/actions/reference/runners/github-hosted-runners
 */
export const GITHUB_LABELS: Record<Exclude<GitHubRunner, "macos">, string> = {
  "linux-1-core": "ubuntu-slim",
  "linux-2-core": "ubuntu-latest",
  "linux-arm-2-core": "ubuntu-24.04-arm",
  "windows-2-core": "windows-latest",
  "windows-arm-2-core": "windows-11-arm",
};

/** The one rate a provider operators added has: a minute of any of its runners. */
export const ADDED_RATE = "runner";

/**
 * Whether a provider has this rate: one RATES lists, or the per-runner rate of a provider RATES
 * doesn't price (the admin only records that one for providers operators added).
 */
export const isRate = (provider: string, rate: string) =>
  Object.hasOwn(RATES, provider)
    ? Object.hasOwn(RATES[provider as PricedProvider], rate)
    : rate === ADDED_RATE;

/**
 * USD for a minute of one rate (per vCPU or per runner, as RATES says), from `from` (a UTC day,
 * YYYY-MM-DD) until the same rate's next row. A rate's first row also covers anything earlier,
 * since it's the oldest price we know.
 */
export interface PriceRow {
  /** A provider in RATES, or one operators added (base rows are all in RATES). */
  provider: string;
  rate: string;
  usd: number;
  from: string;
  /** Set on rows operators recorded (the API's provider_price); base rows have none. */
  id?: string;
  source?: string | null;
  createdBy?: string;
}

const vcpu = (perRunner: number, vcpus: number) => perRunner / vcpus;

export const BASE_PRICES: PriceRow[] = [
  // Blacksmith: $0.004 x64, $0.0025 Arm, $0.008 Windows per 2 vCPU, $0.08 per 6 vCPU macOS.
  // https://www.blacksmith.sh/pricing
  { provider: "blacksmith", rate: "linux", usd: vcpu(0.004, 2), from: "2026-11-11" },
  { provider: "blacksmith", rate: "arm", usd: vcpu(0.0025, 2), from: "2026-11-11" },
  { provider: "blacksmith", rate: "windows", usd: vcpu(0.008, 2), from: "2026-11-11" },
  { provider: "blacksmith", rate: "macos", usd: vcpu(0.08, 6), from: "2026-11-11" },
  // Depot: $0.006 per 2 vCPU on Linux (x64 and Arm), $0.008 on Windows, $0.08 per 8 vCPU macOS.
  // https://depot.dev/docs/github-actions/runner-types.md
  { provider: "depot", rate: "linux", usd: vcpu(0.006, 2), from: "2026-11-11" },
  { provider: "depot", rate: "arm", usd: vcpu(0.006, 2), from: "2026-11-11" },
  { provider: "depot", rate: "windows", usd: vcpu(0.008, 2), from: "2026-11-11" },
  { provider: "depot", rate: "macos", usd: vcpu(0.08, 8), from: "2026-11-11" },
  // WarpBuild: $0.004 x64, $0.003 Arm per 2 vCPU, $0.016 per 4 vCPU Windows, $0.08 per 6 vCPU
  // macOS. https://www.warpbuild.com/pricing.json
  { provider: "warpbuild", rate: "linux", usd: vcpu(0.004, 2), from: "2026-11-11" },
  { provider: "warpbuild", rate: "arm", usd: vcpu(0.003, 2), from: "2026-11-11" },
  { provider: "warpbuild", rate: "windows", usd: vcpu(0.016, 4), from: "2026-11-11" },
  { provider: "warpbuild", rate: "macos", usd: vcpu(0.08, 6), from: "2026-11-11" },
  // Ubicloud, x64 and Arm alike, from the dated rates its billing reads:
  // https://github.com/ubicloud/ubicloud/blob/main/config/billing_rates/github.yml
  { provider: "ubicloud", rate: "standard", usd: vcpu(0.0008, 2), from: "2023-01-01" },
  { provider: "ubicloud", rate: "standard", usd: vcpu(0.001, 2), from: "2026-05-01" },
  { provider: "ubicloud", rate: "standard", usd: vcpu(0.00125, 2), from: "2026-09-01" },
  { provider: "ubicloud", rate: "premium", usd: vcpu(0.0016, 2), from: "2025-05-01" },
  { provider: "ubicloud", rate: "premium", usd: vcpu(0.002, 2), from: "2026-09-01" },
  // Boat, per hour billed by the second: $0.018 small, $0.036 default, $0.072 large, $0.20 xlarge.
  // CI needs its $20 plan or higher. https://docs.boat.dev/pricing
  { provider: "boat", rate: "boat-small", usd: 0.018 / 60, from: "2026-11-16" },
  { provider: "boat", rate: "boat", usd: 0.036 / 60, from: "2026-11-16" },
  { provider: "boat", rate: "boat-large", usd: 0.072 / 60, from: "2026-11-16" },
  { provider: "boat", rate: "boat-xlarge", usd: 0.2 / 60, from: "2026-11-16" },
  // StarSling: $0.004 per 2 vCPU, linear to 64 vCPU. https://starsling.dev/pricing
  { provider: "starsling", rate: "linux", usd: vcpu(0.004, 2), from: "2026-11-17" },
  // Monk CI: $0.002 per vCPU-minute past the plan's minutes. https://monkci.com/pricing
  { provider: "monkci", rate: "linux", usd: 0.002, from: "2026-11-17" },
  // Runloft: $0.003 per 2 vCPU x64, Arm 20% less, Windows $0.007 per 2 vCPU, macOS 15 $0.06.
  // https://runloft.dev/pricing/
  { provider: "runloft", rate: "linux", usd: vcpu(0.003, 2), from: "2026-11-17" },
  { provider: "runloft", rate: "arm", usd: vcpu(0.0024, 2), from: "2026-11-17" },
  { provider: "runloft", rate: "windows", usd: vcpu(0.007, 2), from: "2026-11-17" },
  { provider: "runloft", rate: "macos", usd: 0.06, from: "2026-11-17" },
  // BerryBox: $0.002 per 2 vCPU (8 GiB a vCPU), memory-heavy $0.003 per 2 vCPU.
  // https://docs.berrybox.io/docs/teams-and-billing/billing
  { provider: "berrybox", rate: "linux", usd: vcpu(0.002, 2), from: "2026-11-17" },
  { provider: "berrybox", rate: "memory", usd: vcpu(0.003, 2), from: "2026-11-17" },
  // Latchkey: small $0.0025, medium $0.005, large $0.01, xlarge $0.02. https://latchkey.dev/pricing
  { provider: "latchkey", rate: "latchkey-small", usd: 0.0025, from: "2026-11-17" },
  { provider: "latchkey", rate: "latchkey-medium", usd: 0.005, from: "2026-11-17" },
  { provider: "latchkey", rate: "latchkey-large", usd: 0.01, from: "2026-11-17" },
  { provider: "latchkey", rate: "latchkey-xlarge", usd: 0.02, from: "2026-11-17" },
  // Celesto, per hour: micro $0.015, standard $0.03, memory $0.04, xl $0.16. Small and large
  // aren't listed with a price; they're worked out from the same per-vCPU and per-GB rates
  // (1 vCPU/4 GB and 4 vCPU/16 GB). https://celesto.ai/pricing
  { provider: "celesto", rate: "celesto-micro", usd: 0.015 / 60, from: "2026-11-17" },
  { provider: "celesto", rate: "celesto-small", usd: 0.02 / 60, from: "2026-11-17" },
  { provider: "celesto", rate: "celesto-standard", usd: 0.03 / 60, from: "2026-11-17" },
  { provider: "celesto", rate: "celesto-memory", usd: 0.04 / 60, from: "2026-11-17" },
  { provider: "celesto", rate: "celesto-large", usd: 0.08 / 60, from: "2026-11-17" },
  { provider: "celesto", rate: "celesto-xl", usd: 0.16 / 60, from: "2026-11-17" },
  // InstaBox: $0.004 per vCPU-hour plus $0.00225 per GiB-hour, so per hour small (2/4) $0.017,
  // medium (4/8) $0.034, large $0.068, xlarge $0.136, 2xlarge $0.272.
  // https://instabox.sh/docs/pricing
  { provider: "instabox", rate: "instabox-small", usd: 0.017 / 60, from: "2026-11-17" },
  { provider: "instabox", rate: "instabox-medium", usd: 0.034 / 60, from: "2026-11-17" },
  { provider: "instabox", rate: "instabox-large", usd: 0.068 / 60, from: "2026-11-17" },
  { provider: "instabox", rate: "instabox-xlarge", usd: 0.136 / 60, from: "2026-11-17" },
  { provider: "instabox", rate: "instabox-2xlarge", usd: 0.272 / 60, from: "2026-11-17" },
  // Lizard: Sandbox prices, per hour small (2/4) $0.0162, medium (4/8) $0.0324, large (8/16)
  // $0.0648. https://lizard.build/ci
  { provider: "lizard", rate: "lizard-small", usd: 0.0162 / 60, from: "2026-11-18" },
  { provider: "lizard", rate: "lizard-medium", usd: 0.0324 / 60, from: "2026-11-18" },
  { provider: "lizard", rate: "lizard-large", usd: 0.0648 / 60, from: "2026-11-18" },
  // Groundbox: per minute 2vcpu (2/8) $0.003, 4vcpu (4/16) $0.006, 8vcpu (8/32) $0.011, 16vcpu
  // (16/64) $0.021. Flex runners are the same sizes at half price. https://groundbox.dev/pricing
  { provider: "groundbox", rate: "groundbox-2vcpu", usd: 0.003, from: "2026-11-21" },
  { provider: "groundbox", rate: "groundbox-4vcpu", usd: 0.006, from: "2026-11-21" },
  { provider: "groundbox", rate: "groundbox-8vcpu", usd: 0.011, from: "2026-11-21" },
  { provider: "groundbox", rate: "groundbox-16vcpu", usd: 0.021, from: "2026-11-21" },
  { provider: "groundbox", rate: "groundbox-flex-2vcpu", usd: 0.0015, from: "2026-11-21" },
  { provider: "groundbox", rate: "groundbox-flex-4vcpu", usd: 0.003, from: "2026-11-21" },
  { provider: "groundbox", rate: "groundbox-flex-8vcpu", usd: 0.0055, from: "2026-11-21" },
  { provider: "groundbox", rate: "groundbox-flex-16vcpu", usd: 0.0105, from: "2026-11-21" },
  // Groundbox macOS: $0.05 a minute, one size (12 vCPU M6, 12 GB). https://groundbox.dev/macos-ci
  { provider: "groundbox", rate: "macos", usd: 0.05, from: "2026-11-22" },
  // Groundbox Windows Server 2025: per minute 2vcpu (2/8) $0.006, 4vcpu (4/16) $0.012, 8vcpu (8/32)
  // $0.022, 16vcpu (16/64) $0.042. https://groundbox.dev/windows-ci
  { provider: "groundbox", rate: "groundbox-windows-2vcpu", usd: 0.006, from: "2026-11-22" },
  { provider: "groundbox", rate: "groundbox-windows-4vcpu", usd: 0.012, from: "2026-11-22" },
  { provider: "groundbox", rate: "groundbox-windows-8vcpu", usd: 0.022, from: "2026-11-22" },
  { provider: "groundbox", rate: "groundbox-windows-16vcpu", usd: 0.042, from: "2026-11-22" },
  // GitHub, in a private repo; standard runners are free in public ones.
  // https://docs.github.com/en/billing/reference/actions-runner-pricing
  { provider: "github", rate: "linux-1-core", usd: 0.002, from: "2026-11-11" },
  { provider: "github", rate: "linux-2-core", usd: 0.006, from: "2026-11-11" },
  { provider: "github", rate: "linux-arm-2-core", usd: 0.005, from: "2026-11-11" },
  { provider: "github", rate: "windows-2-core", usd: 0.01, from: "2026-11-11" },
  { provider: "github", rate: "windows-arm-2-core", usd: 0.01, from: "2026-11-11" },
  { provider: "github", rate: "macos", usd: 0.062, from: "2026-11-11" },
  ...GITHUB_LARGER.map(({ rate, usd }) => ({ provider: "github", rate, usd, from: "2026-11-20" })),
];

/** A UTC day (YYYY-MM-DD) as epoch ms at its midnight. */
export const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Price rows, ready to look up. Build one with priceBook. */
export interface PriceBook {
  /** USD for a minute of a rate at `at` (epoch ms), or null when it has no rows. */
  usd(provider: string, rate: string, at: number): number | null;
  /** A rate's rows in effect, oldest first. */
  history(provider: string, rate: string): PriceRow[];
  /**
   * Every moment a price changed, oldest first, as epoch ms. Between two of these every price is
   * fixed, so a report can sum minutes per stretch and price each stretch once.
   */
  changes: number[];
}

/**
 * Looks up price rows, leaving out any for a rate RATES doesn't list. Rows for the same rate and
 * day replace earlier ones in the list, so rows added on top of BASE_PRICES win.
 */
export function priceBook(rows: PriceRow[]): PriceBook {
  const byRate = new Map<string, Map<string, PriceRow>>();
  for (const row of rows) {
    if (!isRate(row.provider, row.rate)) continue;
    const key = `${row.provider}:${row.rate}`;
    const days = byRate.get(key) ?? new Map<string, PriceRow>();
    days.set(row.from, row);
    byRate.set(key, days);
  }
  const histories = new Map(
    [...byRate].map(([key, days]) => [
      key,
      [...days.values()].sort((a, b) => a.from.localeCompare(b.from)),
    ]),
  );
  const changes = new Set<number>();
  for (const history of histories.values())
    for (const row of history.slice(1)) changes.add(dayMs(row.from));
  const history = (provider: string, rate: string) => histories.get(`${provider}:${rate}`) ?? [];
  return {
    usd(provider, rate, at) {
      let usd: number | null = null;
      for (const [i, row] of history(provider, rate).entries())
        if (i === 0 || dayMs(row.from) <= at) usd = row.usd;
      return usd;
    },
    history,
    changes: [...changes].sort((a, b) => a - b),
  };
}

const RATE_NAMES: Record<string, string> = {
  linux: "Linux x64",
  arm: "Linux Arm",
  windows: "Windows",
  macos: "macOS",
  standard: "Standard",
  premium: "Premium",
  memory: "Memory-heavy",
  ...GITHUB_LABELS,
  // GitHub's larger runners have no fixed label, so they go by size: "Linux Arm 8-core".
  ...Object.fromEntries(GITHUB_LARGER.map(({ rate, name }) => [rate, name])),
};

/** A rate as people say it, such as "Linux Arm" or `ubuntu-slim`. */
export const rateName = (rate: string) => RATE_NAMES[rate] ?? rate;

/** One of a provider's rates with every price it has had, oldest first. */
export interface RatePrices {
  rate: string;
  per: "vcpu" | "runner";
  history: { usd: number; from: string }[];
}

/** A provider's rates and their price history, or none for a provider without list prices. */
export function ratePrices(book: PriceBook, provider: string): RatePrices[] {
  if (!Object.hasOwn(RATES, provider)) return [];
  return Object.entries(RATES[provider as PricedProvider]).map(([rate, per]) => ({
    rate,
    per,
    history: book.history(provider, rate).map(({ usd, from }) => ({ usd, from })),
  }));
}

/** The row of a price history (oldest first) in effect at `at`: the oldest row also covers earlier. */
export const priceAt = <T extends { from: string }>(history: T[], at = Date.now()) =>
  history.findLast((row, i) => i === 0 || dayMs(row.from) <= at);

/** The base list on its own, for places without the API's rows, such as the docs site. */
export const BASE_BOOK = priceBook(BASE_PRICES);

/** "$0.008/min", or "—" without a known price. */
export const rateText = (perMinute: number | null) =>
  perMinute === null ? "—" : `$${Number(perMinute.toFixed(5))}/min`;

/** What a minute on one of GitHub's standard runners cost in a private repo at `at`. */
export const githubRate = (book: PriceBook, runner: GitHubRunner, at = Date.now()) =>
  book.usd("github", runner, at);

// A sized service's rate for a label: macOS, Windows, Arm, or Linux on x64.
/** The platform a lowercase runner label names: macos, windows, arm or (otherwise) linux. */
export const platformOf = (label: string) => {
  if (label.includes("macos")) return "macos";
  if (label.includes("windows")) return "windows";
  return label.includes("arm") ? "arm" : "linux";
};

/**
 * The platform a provider's runner label asks for, or null when the label doesn't say (a
 * Namespace profile or a GitHub larger runner is named by whoever made it). For GitHub, `label`
 * is the standard runner's rate, such as `linux-arm-2-core`.
 */
export function runnerPlatform(provider: string, label: string): RunnerPlatform | null {
  const lower = label.toLowerCase();
  if (provider === "github" && !Object.hasOwn(RATES.github, lower)) return null;
  if (provider === "namespace" && lower.startsWith("namespace-profile-")) return null;
  if (provider === "ubicloud") return lower.includes("gpu") ? null : platformOf(lower);
  const platform = platformOf(lower);
  return platform === "windows" && lower.includes("arm") ? "windows-arm" : platform;
}

// Whether a rate is priced per runner rather than per vCPU.
const isRunnerRate = (provider: string, rate: string) =>
  Object.hasOwn(RATES, provider) &&
  (RATES[provider as PricedProvider] as Record<string, string>)[rate] === "runner";

/** Whether RelayRunner knows a hosted provider's list prices, so it can count what jobs cost. */
export const hasListPrices = (provider: string) =>
  provider !== "github" && Object.hasOwn(RATES, provider);

// The size a label asks for, or the service's smallest when it doesn't say.
const vcpusIn = (label: string, pattern: RegExp, fallback: number) => {
  const match = pattern.exec(label);
  return match ? Number(match[1]) : fallback;
};

// Boat's sizes, by label. https://docs.boat.dev/machines
const BOAT_VCPUS: Partial<Record<string, number>> = {
  "boat-small": 2,
  boat: 4,
  "boat-large": 8,
  "boat-xlarge": 16,
};

// Runners named by size rather than vCPU count, by their label's first part.
const NAMED_RUNNERS: Partial<Record<string, RunnerSize>> = {
  // https://latchkey.dev/pricing
  "latchkey-small": { vcpus: 2, memoryGb: 8 },
  "latchkey-medium": { vcpus: 4, memoryGb: 16 },
  "latchkey-large": { vcpus: 8, memoryGb: 32 },
  "latchkey-xlarge": { vcpus: 16, memoryGb: 64 },
  // https://celesto.ai/docs/ci/runner-sizes.md (a bare `celesto` is micro)
  "celesto-micro": { vcpus: 1, memoryGb: 2 },
  "celesto-small": { vcpus: 1, memoryGb: 4 },
  "celesto-standard": { vcpus: 2, memoryGb: 4 },
  "celesto-memory": { vcpus: 2, memoryGb: 8 },
  "celesto-large": { vcpus: 4, memoryGb: 16 },
  "celesto-xl": { vcpus: 8, memoryGb: 32 },
  // https://instabox.sh/docs/use-cases/ci (`-snapshot-<name>` may follow the size)
  "instabox-small": { vcpus: 2, memoryGb: 4 },
  "instabox-medium": { vcpus: 4, memoryGb: 8 },
  "instabox-large": { vcpus: 8, memoryGb: 16 },
  "instabox-xlarge": { vcpus: 16, memoryGb: 32 },
  "instabox-2xlarge": { vcpus: 32, memoryGb: 64 },
  // https://lizard.build/ci (`-ubuntu-2404` follows the size)
  "lizard-small": { vcpus: 2, memoryGb: 4 },
  "lizard-medium": { vcpus: 4, memoryGb: 8 },
  "lizard-large": { vcpus: 8, memoryGb: 16 },
};

// Groundbox's sizes, 4 GB a vCPU, on Linux and Windows. https://groundbox.dev/pricing and
// https://groundbox.dev/windows-ci
const GROUNDBOX_VCPUS = [2, 4, 8, 16];

// Groundbox's one macOS size, a 12 vCPU M6 with 12 GB. https://groundbox.dev/macos-ci
const GROUNDBOX_MACOS: RunnerSize = { vcpus: 12, memoryGb: 12 };

// The Groundbox rate a label asks for: `groundbox-4vcpu-ubuntu-2404` is groundbox-4vcpu, a bare
// `groundbox-flex` is groundbox-flex-4vcpu, a bare `groundbox-windows` is groundbox-windows-4vcpu,
// and `groundbox-macos` is macos. Null for the auto size (`groundbox`, `groundbox-auto-<name>`),
// which picks a size per job, so the label doesn't say.
function groundboxRate(label: string): { rate: string; vcpus: number } | null {
  if (label === "groundbox-macos") return { rate: "macos", vcpus: GROUNDBOX_MACOS.vcpus };
  if (label === "groundbox-flex") return { rate: "groundbox-flex-4vcpu", vcpus: 4 };
  if (label === "groundbox-windows") return { rate: "groundbox-windows-4vcpu", vcpus: 4 };
  const windows = /^groundbox-windows-(\d+)vcpu$/.exec(label);
  if (windows) {
    const vcpus = Number(windows[1]);
    return GROUNDBOX_VCPUS.includes(vcpus)
      ? { rate: `groundbox-windows-${vcpus}vcpu`, vcpus }
      : null;
  }
  const match = /^groundbox-(flex-)?(\d+)vcpu(?:-ubuntu-2404)?$/.exec(label);
  const vcpus = Number(match?.[2]);
  return match && GROUNDBOX_VCPUS.includes(vcpus)
    ? { rate: `groundbox-${match[1] ?? ""}${vcpus}vcpu`, vcpus }
    : null;
}

// The size-named runner a label asks for: `celesto` is micro, `instabox-medium-snapshot-x` medium.
const namedRunner = (label: string) => {
  if (label === "celesto") return "celesto-micro";
  const [provider, size] = label.split("-");
  return `${provider}-${size}`;
};

// A label's rate and vCPU count, or null when RelayRunner can't tell.
function rateOf(provider: ProviderId, label: string): { rate: string; vcpus: number } | null {
  switch (provider) {
    // blacksmith-4vcpu-ubuntu-2404, blacksmith-2vcpu-ubuntu-2404-arm, blacksmith-6vcpu-macos-15
    case "blacksmith":
      return { rate: platformOf(label), vcpus: vcpusIn(label, /-(\d+)vcpu-/, 2) };
    // depot-ubuntu-24.04-8, depot-ubuntu-24.04-arm, depot-windows-2025-4, depot-macos-15
    // (macOS comes in one size, 8 vCPU.)
    case "depot":
      return {
        rate: platformOf(label),
        vcpus: label.includes("macos") ? 8 : vcpusIn(label, /-(\d{1,2})$/, 2),
      };
    // warp-ubuntu-latest-x64-4x, warp-ubuntu-2404-arm64-2x-spot, warp-macos-15-arm64-6x
    case "warpbuild":
      return { rate: platformOf(label), vcpus: vcpusIn(label, /-(\d+)x(?=-|$)/, 2) };
    // boat-small, boat, boat-large, boat-xlarge, each optionally followed by /options.
    case "boat": {
      const size = label.split("/")[0]!;
      const vcpus = BOAT_VCPUS[size];
      return vcpus ? { rate: size, vcpus } : null;
    }
    // starsling-ubuntu-24.04-8; no suffix is 4 vCPU. GPU runners aren't priced here.
    case "starsling":
      if (label.includes("gpu")) return null;
      return { rate: "linux", vcpus: vcpusIn(label, /-\d+\.\d+-(\d+)$/, 4) };
    // monkci-ubuntu-24.04-4; monkci-ubuntu-latest is the largest, 32 vCPU.
    case "monkci":
      return { rate: "linux", vcpus: vcpusIn(label, /-\d+\.\d+-(\d+)$/, 32) };
    // runloft-ubuntu-24.04[-arm][-8cpu], runloft-windows-2025-4cpu, runloft-macos-15, runloft-2cpu
    case "runloft":
      if (label.includes("macos")) return { rate: "macos", vcpus: 1 };
      return { rate: platformOf(label), vcpus: vcpusIn(label, /-(\d+)cpu$/, 2) };
    // berrybox-4vcpu-ubuntu-2404, berrybox-memory-2vcpu-ubuntu-2404, berrybox-ubuntu-latest (2)
    case "berrybox":
      return {
        rate: label.includes("-memory-") ? "memory" : "linux",
        vcpus: vcpusIn(label, /-(\d+)vcpu-/, 2),
      };
    case "latchkey":
    case "celesto":
    case "instabox":
    case "lizard": {
      const rate = namedRunner(label);
      const size = NAMED_RUNNERS[rate];
      return size ? { rate, vcpus: size.vcpus } : null;
    }
    // groundbox-4vcpu[-ubuntu-2404], groundbox-flex[-8vcpu], groundbox-windows[-8vcpu],
    // groundbox-macos; the auto size isn't priced here.
    case "groundbox":
      return groundboxRate(label);
    // ubicloud, ubicloud-standard-4, ubicloud-standard-2-arm, ubicloud-premium-8-ubuntu-2404
    case "ubicloud":
      if (label.includes("gpu")) return null;
      return {
        rate: label.includes("premium") ? "premium" : "standard",
        vcpus: vcpusIn(label, /-(?:standard|premium)-(\d+)/, 2),
      };
    default:
      return null;
  }
}

/**
 * What a minute cost on a runner type at `at` (epoch ms, now by default), at list price, by the
 * label that names it (as the Job times environment carries it, lowercase), or null when
 * RelayRunner doesn't know: Namespace profiles, Groundbox's auto size and RunsOn don't say their
 * size in the label, and GitHub's runners are priced by githubRate.
 */
export function listRate(
  book: PriceBook,
  provider: ProviderId,
  label: string,
  at = Date.now(),
): number | null {
  const sized = rateOf(provider, label);
  if (!sized) return null;
  const usd = book.usd(provider, sized.rate, at);
  if (usd === null) return null;
  return isRunnerRate(provider, sized.rate) ? usd : usd * sized.vcpus;
}

/** How big a runner is: its vCPUs, and its memory when the label or the service says. */
export interface RunnerSize {
  vcpus: number;
  memoryGb?: number;
}

// GitHub's runners in a private repo, by the rate that names them. Standard macOS isn't here: its
// size differs by image (Intel or Apple silicon).
const GITHUB_SIZES: Partial<Record<string, RunnerSize>> = {
  "linux-1-core": { vcpus: 1, memoryGb: 5 },
  "linux-2-core": { vcpus: 2, memoryGb: 8 },
  "linux-arm-2-core": { vcpus: 2, memoryGb: 8 },
  "windows-2-core": { vcpus: 2, memoryGb: 8 },
  "windows-arm-2-core": { vcpus: 2, memoryGb: 8 },
  ...Object.fromEntries(GITHUB_LARGER.map(({ rate, size }) => [rate, size])),
};

// Cloudflare Containers instance types RelayRunner runs jobs on.
const CLOUDFLARE_SIZES: Partial<Record<string, RunnerSize>> = {
  "standard-1": { vcpus: 0.5, memoryGb: 4 },
  "standard-2": { vcpus: 1, memoryGb: 6 },
  "standard-3": { vcpus: 2, memoryGb: 8 },
  "standard-4": { vcpus: 4, memoryGb: 12 },
};

// A size written into a label its owner named, such as `ubuntu-24.04-16core` or `linux-8-cores`.
const NAMED_SIZE = /(?:^|[-_.])(\d{1,3})-?(?:v?cpus?|cores?)(?=$|[-_.])/;

const count = (match: RegExpExecArray | null) => (match ? Number(match[1]) || null : null);

/**
 * A runner's size by its provider and the label that names it (lowercase, as the Job times
 * environment carries it), or null when RelayRunner can't tell, such as a Namespace profile.
 */
export function runnerSize(provider: string, label: string): RunnerSize | null {
  switch (provider) {
    case "github":
      return GITHUB_SIZES[label] ?? named(label);
    case "cloudflare":
      return CLOUDFLARE_SIZES[label] ?? null;
    // nscloud-ubuntu-22.04-amd64-4x16: 4 vCPU, 16 GB. Profiles don't say.
    case "namespace": {
      const match = /-(\d+)x(\d+)$/.exec(label);
      return match ? { vcpus: Number(match[1]), memoryGb: Number(match[2]) } : null;
    }
    // boat-small is 2 vCPU · 4 GB; each size up doubles both.
    case "boat": {
      const vcpus = BOAT_VCPUS[label.split("/")[0]!];
      return vcpus ? { vcpus, memoryGb: vcpus * 2 } : null;
    }
    // Named sizes, with their memory.
    case "latchkey":
    case "celesto":
    case "instabox":
    case "lizard":
      return NAMED_RUNNERS[namedRunner(label)] ?? null;
    // groundbox-8vcpu and groundbox-windows-8vcpu are 8 vCPU · 32 GB, groundbox-macos 12 vCPU · 12 GB.
    // The auto size doesn't say.
    case "groundbox": {
      if (label === "groundbox-macos") return GROUNDBOX_MACOS;
      const vcpus = groundboxRate(label)?.vcpus;
      return vcpus ? { vcpus, memoryGb: vcpus * 4 } : null;
    }
    // The runner= part of its labels, such as 2cpu-linux-x64.
    case "runs-on": {
      const vcpus = count(/^(\d+)cpu-/.exec(label));
      return vcpus ? { vcpus } : null;
    }
    default: {
      // The sized services, else a size in the label (other runners, providers added in the admin).
      const sized = rateOf(provider as ProviderId, label);
      return sized ? { vcpus: sized.vcpus } : named(label);
    }
  }
}

function named(label: string): RunnerSize | null {
  const vcpus = count(NAMED_SIZE.exec(label));
  return vcpus ? { vcpus } : null;
}

/** "4 vCPU · 16 GB", or null for an unknown size. */
export function sizeText(size: RunnerSize | null | undefined): string | null {
  if (!size) return null;
  const vcpus = `${size.vcpus} vCPU`;
  return size.memoryGb ? `${vcpus} · ${size.memoryGb} GB` : vcpus;
}
