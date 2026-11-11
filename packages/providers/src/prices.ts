// List prices for hosted runners, per minute in USD, read from each service's public price page.
// They are estimates: RelayRunner never sees the bill, so plan allowances, credits and discounts
// are left out.
//
// Each price list is dated. A change adds a new entry with the day it took effect and leaves the
// old ones alone, so a job is always priced at what a minute cost on the day it ran.
import type { ProviderId } from "./index.ts";

/** When the prices below were last checked against the services' pages. */
export const PRICES_CHECKED = "2026-11-11";

/**
 * Prices that hold from `from` (a UTC day, YYYY-MM-DD) until the next entry's day. The first entry
 * also covers anything earlier, since it's the oldest price we know.
 */
export interface Dated<T> {
  from: string;
  rates: T;
}

// USD per vCPU-minute by platform. Services price by size, and each size doubles the last.
interface SizedRates {
  linux: number;
  arm: number;
  windows: number;
  macos: number;
}

// Blacksmith: $0.004 x64, $0.0025 Arm, $0.008 Windows per 2 vCPU, $0.08 per 6 vCPU macOS.
// https://www.blacksmith.sh/pricing
const BLACKSMITH: Dated<SizedRates>[] = [
  { from: "2026-11-11", rates: { linux: 0.002, arm: 0.00125, windows: 0.004, macos: 0.08 / 6 } },
];

// Depot: $0.006 per 2 vCPU on Linux (x64 and Arm), $0.008 on Windows, $0.08 per 8 vCPU macOS.
// https://depot.dev/docs/github-actions/runner-types.md
const DEPOT: Dated<SizedRates>[] = [
  { from: "2026-11-11", rates: { linux: 0.003, arm: 0.003, windows: 0.004, macos: 0.01 } },
];

// WarpBuild: $0.004 x64, $0.003 Arm per 2 vCPU, $0.016 per 4 vCPU Windows, $0.08 per 6 vCPU macOS.
// https://www.warpbuild.com/pricing.json
const WARPBUILD: Dated<SizedRates>[] = [
  { from: "2026-11-11", rates: { linux: 0.002, arm: 0.0015, windows: 0.004, macos: 0.08 / 6 } },
];

// Ubicloud, per vCPU (x64 and Arm alike), from the dated rates its billing reads:
// https://github.com/ubicloud/ubicloud/blob/main/config/billing_rates/github.yml
const UBICLOUD: Dated<{ standard: number; premium: number }>[] = [
  { from: "2023-01-01", rates: { standard: 0.0004, premium: 0.0008 } },
  { from: "2026-05-01", rates: { standard: 0.0005, premium: 0.0008 } },
  { from: "2026-09-01", rates: { standard: 0.000625, premium: 0.001 } },
];

/** GitHub's standard hosted runners, the ones it publishes a per-minute price for. */
export type GitHubRunner =
  | "linux-1-core"
  | "linux-2-core"
  | "linux-arm-2-core"
  | "windows-2-core"
  | "windows-arm-2-core"
  | "macos";

// In a private repo; standard runners are free in public ones.
// https://docs.github.com/en/billing/reference/actions-runner-pricing
const GITHUB: Dated<Record<GitHubRunner, number>>[] = [
  {
    from: "2026-11-11",
    rates: {
      "linux-1-core": 0.002,
      "linux-2-core": 0.006,
      "linux-arm-2-core": 0.005,
      "windows-2-core": 0.01,
      "windows-arm-2-core": 0.01,
      macos: 0.062,
    },
  },
];

const HISTORIES: Dated<unknown>[][] = [BLACKSMITH, DEPOT, WARPBUILD, UBICLOUD, GITHUB];

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The entry in effect at `at` (epoch ms). Entries are oldest first. */
export function priceAt<T>(history: Dated<T>[], at: number): T {
  let current = history[0]!;
  for (const entry of history) if (dayMs(entry.from) <= at) current = entry;
  return current.rates;
}

/**
 * Every moment a price changed, oldest first, as epoch ms: the days of each entry after a list's
 * first. Between two of these every price is fixed, so a report can sum minutes per stretch and
 * price each stretch once.
 */
export const PRICE_CHANGES: number[] = [
  ...new Set(HISTORIES.flatMap((history) => history.slice(1).map((entry) => dayMs(entry.from)))),
].sort((a, b) => a - b);

/** What a minute on one of GitHub's standard runners costs in a private repo at `at`. */
export const githubRate = (runner: GitHubRunner, at = Date.now()) => priceAt(GITHUB, at)[runner];

/** "$0.008/min", or "—" without a known price. */
export const rateText = (perMinute: number | null) =>
  perMinute === null ? "—" : `$${Number(perMinute.toFixed(5))}/min`;

function sized(rates: SizedRates, label: string, vcpus: number): number {
  if (label.includes("macos")) return rates.macos * vcpus;
  if (label.includes("windows")) return rates.windows * vcpus;
  return (label.includes("arm") ? rates.arm : rates.linux) * vcpus;
}

// The size a label asks for, or the service's smallest when it doesn't say.
const vcpusIn = (label: string, pattern: RegExp, fallback: number) => {
  const match = pattern.exec(label);
  return match ? Number(match[1]) : fallback;
};

/**
 * What a minute cost on a runner type at `at` (epoch ms, now by default), at list price, by the
 * label that names it (as the Job times environment carries it, lowercase), or null when
 * RelayRunner doesn't know: Namespace profiles and RunsOn don't say their size in the label, and
 * GitHub's runners are priced by githubRate.
 */
export function listRate(provider: ProviderId, label: string, at = Date.now()): number | null {
  switch (provider) {
    // blacksmith-4vcpu-ubuntu-2404, blacksmith-2vcpu-ubuntu-2404-arm, blacksmith-6vcpu-macos-15
    case "blacksmith":
      return sized(priceAt(BLACKSMITH, at), label, vcpusIn(label, /-(\d+)vcpu-/, 2));
    // depot-ubuntu-24.04-8, depot-ubuntu-24.04-arm, depot-windows-2025-4, depot-macos-15
    // (macOS comes in one size, 8 vCPU.)
    case "depot": {
      const vcpus = label.includes("macos") ? 8 : vcpusIn(label, /-(\d{1,2})$/, 2);
      return sized(priceAt(DEPOT, at), label, vcpus);
    }
    // warp-ubuntu-latest-x64-4x, warp-ubuntu-2404-arm64-2x, warp-macos-15-arm64-6x
    case "warpbuild":
      return sized(priceAt(WARPBUILD, at), label, vcpusIn(label, /-(\d+)x$/, 2));
    // ubicloud, ubicloud-standard-4, ubicloud-standard-2-arm, ubicloud-premium-8
    case "ubicloud": {
      if (label.includes("gpu")) return null;
      const rates = priceAt(UBICLOUD, at);
      const vcpus = vcpusIn(label, /-(\d+)(-arm)?$/, 2);
      return (label.includes("premium") ? rates.premium : rates.standard) * vcpus;
    }
    default:
      return null;
  }
}
