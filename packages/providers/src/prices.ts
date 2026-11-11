// List prices for the hosted runner services, per minute in USD, read from each service's public
// price page. They are estimates for a provider's page: RelayRunner never sees the bill, so plan
// allowances, credits and discounts are left out. GitHub's own rates live with the Usage report
// (apps/api/src/job-timings.ts), since public repos change them.
import type { ProviderId } from "./index.ts";

/** When the prices below were last checked against the services' pages. */
export const PRICES_CHECKED = "2026-11-11";

// USD per vCPU-minute by platform. Services price by size, and each size doubles the last.
interface SizedRates {
  linux: number;
  arm: number;
  windows: number;
  macos: number;
}

// Blacksmith: $0.004 x64, $0.0025 Arm, $0.008 Windows per 2 vCPU, $0.08 per 6 vCPU macOS.
const BLACKSMITH: SizedRates = { linux: 0.002, arm: 0.00125, windows: 0.004, macos: 0.08 / 6 };
// Depot: $0.006 per 2 vCPU on Linux (x64 and Arm), $0.008 on Windows, $0.08 per 8 vCPU macOS.
const DEPOT: SizedRates = { linux: 0.003, arm: 0.003, windows: 0.004, macos: 0.01 };
// WarpBuild: $0.004 x64, $0.003 Arm per 2 vCPU, $0.016 per 4 vCPU Windows, $0.08 per 6 vCPU macOS.
const WARPBUILD: SizedRates = { linux: 0.002, arm: 0.0015, windows: 0.004, macos: 0.08 / 6 };
// Ubicloud: standard $0.00125 per 2 vCPU (x64 and Arm), premium $0.002 per 2 vCPU.
const UBICLOUD_STANDARD = 0.000625;
const UBICLOUD_PREMIUM = 0.001;

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
 * What a minute on a runner type costs at list price, by the label that names it (as the Job times
 * environment carries it, lowercase), or null when RelayRunner doesn't know: Namespace profiles and
 * RunsOn don't say their size in the label, and GitHub is priced elsewhere.
 */
export function listRate(provider: ProviderId, label: string): number | null {
  switch (provider) {
    // blacksmith-4vcpu-ubuntu-2404, blacksmith-2vcpu-ubuntu-2404-arm, blacksmith-6vcpu-macos-15
    case "blacksmith":
      return sized(BLACKSMITH, label, vcpusIn(label, /-(\d+)vcpu-/, 2));
    // depot-ubuntu-24.04-8, depot-ubuntu-24.04-arm, depot-windows-2025-4, depot-macos-15
    // (macOS comes in one size, 8 vCPU.)
    case "depot":
      return sized(DEPOT, label, label.includes("macos") ? 8 : vcpusIn(label, /-(\d{1,2})$/, 2));
    // warp-ubuntu-latest-x64-4x, warp-ubuntu-2404-arm64-2x, warp-macos-15-arm64-6x
    case "warpbuild":
      return sized(WARPBUILD, label, vcpusIn(label, /-(\d+)x$/, 2));
    // ubicloud, ubicloud-standard-4, ubicloud-standard-2-arm, ubicloud-premium-8
    case "ubicloud": {
      if (label.includes("gpu")) return null;
      const vcpus = vcpusIn(label, /-(\d+)(-arm)?$/, 2);
      return (label.includes("premium") ? UBICLOUD_PREMIUM : UBICLOUD_STANDARD) * vcpus;
    }
    default:
      return null;
  }
}
