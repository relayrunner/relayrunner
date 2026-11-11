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

/** A provider's rates, and what one minute of each is per. */
export const RATES = {
  blacksmith: { linux: "vcpu", arm: "vcpu", windows: "vcpu", macos: "vcpu" },
  depot: { linux: "vcpu", arm: "vcpu", windows: "vcpu", macos: "vcpu" },
  warpbuild: { linux: "vcpu", arm: "vcpu", windows: "vcpu", macos: "vcpu" },
  ubicloud: { standard: "vcpu", premium: "vcpu" },
  github: {
    "linux-1-core": "runner",
    "linux-2-core": "runner",
    "linux-arm-2-core": "runner",
    "windows-2-core": "runner",
    "windows-arm-2-core": "runner",
    macos: "runner",
  },
} as const satisfies Partial<Record<ProviderId, Record<string, "vcpu" | "runner">>>;

export type PricedProvider = keyof typeof RATES;

/** GitHub's standard hosted runners, the ones it publishes a per-minute price for. */
export type GitHubRunner = keyof (typeof RATES)["github"];

export const isRate = (provider: string, rate: string) =>
  Object.hasOwn(RATES, provider) && Object.hasOwn(RATES[provider as PricedProvider], rate);

/**
 * USD for a minute of one rate (per vCPU or per runner, as RATES says), from `from` (a UTC day,
 * YYYY-MM-DD) until the same rate's next row. A rate's first row also covers anything earlier,
 * since it's the oldest price we know.
 */
export interface PriceRow {
  provider: PricedProvider;
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
  // GitHub, in a private repo; standard runners are free in public ones.
  // https://docs.github.com/en/billing/reference/actions-runner-pricing
  { provider: "github", rate: "linux-1-core", usd: 0.002, from: "2026-11-11" },
  { provider: "github", rate: "linux-2-core", usd: 0.006, from: "2026-11-11" },
  { provider: "github", rate: "linux-arm-2-core", usd: 0.005, from: "2026-11-11" },
  { provider: "github", rate: "windows-2-core", usd: 0.01, from: "2026-11-11" },
  { provider: "github", rate: "windows-arm-2-core", usd: 0.01, from: "2026-11-11" },
  { provider: "github", rate: "macos", usd: 0.062, from: "2026-11-11" },
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
  "linux-1-core": "Linux 1-core",
  "linux-2-core": "Linux 2-core",
  "linux-arm-2-core": "Linux Arm 2-core",
  "windows-2-core": "Windows 2-core",
  "windows-arm-2-core": "Windows Arm 2-core",
};

/** A rate as people say it, such as "Linux Arm". */
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

/** The base list on its own, for places without the API's rows, such as the docs site. */
export const BASE_BOOK = priceBook(BASE_PRICES);

/** "$0.008/min", or "—" without a known price. */
export const rateText = (perMinute: number | null) =>
  perMinute === null ? "—" : `$${Number(perMinute.toFixed(5))}/min`;

/** What a minute on one of GitHub's standard runners cost in a private repo at `at`. */
export const githubRate = (book: PriceBook, runner: GitHubRunner, at = Date.now()) =>
  book.usd("github", runner, at);

// A sized service's rate for a label: macOS, Windows, Arm, or Linux on x64.
const platformOf = (label: string) => {
  if (label.includes("macos")) return "macos";
  if (label.includes("windows")) return "windows";
  return label.includes("arm") ? "arm" : "linux";
};

// The size a label asks for, or the service's smallest when it doesn't say.
const vcpusIn = (label: string, pattern: RegExp, fallback: number) => {
  const match = pattern.exec(label);
  return match ? Number(match[1]) : fallback;
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
    // warp-ubuntu-latest-x64-4x, warp-ubuntu-2404-arm64-2x, warp-macos-15-arm64-6x
    case "warpbuild":
      return { rate: platformOf(label), vcpus: vcpusIn(label, /-(\d+)x$/, 2) };
    // ubicloud, ubicloud-standard-4, ubicloud-standard-2-arm, ubicloud-premium-8
    case "ubicloud":
      if (label.includes("gpu")) return null;
      return {
        rate: label.includes("premium") ? "premium" : "standard",
        vcpus: vcpusIn(label, /-(\d+)(-arm)?$/, 2),
      };
    default:
      return null;
  }
}

/**
 * What a minute cost on a runner type at `at` (epoch ms, now by default), at list price, by the
 * label that names it (as the Job times environment carries it, lowercase), or null when
 * RelayRunner doesn't know: Namespace profiles and RunsOn don't say their size in the label, and
 * GitHub's runners are priced by githubRate.
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
  return usd === null ? null : usd * sized.vcpus;
}
