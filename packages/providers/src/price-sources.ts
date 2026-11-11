// Where each provider publishes its prices, and how to read them off that page. The API checks
// these once a day (apps/api/src/price-check.ts) and holds any change for an operator to approve.
// Parsers return what they found and throw when the page no longer looks the way they expect, so
// a redesign shows up as a failed check instead of a wrong price.
import type { PricedProvider } from "./prices.ts";

/** A price read off a provider's page: USD a minute per vCPU or per runner, as RATES says. */
export interface FoundPrice {
  rate: string;
  usd: number;
  /** The day it takes effect, when the source says (YYYY-MM-DD). */
  from?: string;
}

export interface PriceSource {
  provider: PricedProvider;
  /** What the check fetches. */
  url: string;
  /** Where a person reads the same prices, for links. */
  page: string;
  parse(body: string): FoundPrice[];
}

const dollars = (text: string) => {
  const match = /\$\s*(\d+(?:\.\d+)?)/.exec(text);
  if (!match) throw new Error(`no price in "${text.slice(0, 80)}"`);
  return Number(match[1]);
};

// The cells of the first Markdown table row whose cell matches, trimmed.
function tableRow(body: string, matches: (cell: string) => boolean): string[] {
  for (const line of body.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.some(matches)) return cells;
  }
  throw new Error("row not found");
}

const priceCell = (cells: string[]) => dollars(cells.find((cell) => cell.includes("$")) ?? "");

// The runner a row names, by its first cell's first `code` span.
const runnerIs = (label: string) => (cell: string) => /`([^`]+)`/.exec(cell)?.[1] === label;

function found(rate: string, usd: number, from?: string): FoundPrice {
  if (!(usd > 0 && usd < 1)) throw new Error(`${rate}: unlikely price ${usd}`);
  return from ? { rate, usd, from } : { rate, usd };
}

export const PRICE_SOURCES: PriceSource[] = [
  {
    provider: "blacksmith",
    url: "https://www.blacksmith.sh/pricing",
    page: "https://www.blacksmith.sh/pricing",
    // Each price sits in an element by id: per 2 vCPU on Linux and Windows, per 6 on macOS.
    parse(html) {
      const price = (id: string) => {
        const match = new RegExp(`id="${id}"[^>]*>\\s*([^<]+)`).exec(html);
        if (!match) throw new Error(`#${id} not found`);
        return dollars(match[1]!);
      };
      return [
        found("linux", price("base-price") / 2),
        found("arm", price("arm-price") / 2),
        found("windows", price("win-price") / 2),
        found("macos", price("mac-price") / 6),
      ];
    },
  },
  {
    provider: "depot",
    url: "https://depot.dev/docs/github-actions/runner-types.md",
    page: "https://depot.dev/docs/github-actions/runner-types",
    // A table per platform: label, CPUs, ..., price a minute.
    parse(md) {
      const perVcpu = (rate: string, label: string) => {
        const cells = tableRow(md, runnerIs(label));
        return found(rate, priceCell(cells) / Number(cells[1]));
      };
      return [
        perVcpu("linux", "depot-ubuntu-24.04"),
        perVcpu("arm", "depot-ubuntu-24.04-arm"),
        perVcpu("windows", "depot-windows-2025"),
        perVcpu("macos", "depot-macos-15"),
      ];
    },
  },
  {
    provider: "warpbuild",
    url: "https://www.warpbuild.com/pricing.json",
    page: "https://www.warpbuild.com/pricing",
    // Every runner type with its platform, vCPUs and price; the smallest of each platform sets
    // the rate. Arm's "xfast" types are a separate, pricier line RelayRunner doesn't price.
    parse(json) {
      const { runners } = JSON.parse(json) as {
        runners: { runner_type: string; per_minute_usd: number; platform: string; vcpu: number }[];
      };
      const smallest = (rate: string, platform: string) => {
        const runner = runners
          .filter((r) => r.platform === platform && !r.runner_type.includes("xfast") && r.vcpu > 0)
          .sort((a, b) => a.vcpu - b.vcpu)[0];
        if (!runner) throw new Error(`no ${platform} runner`);
        return found(rate, runner.per_minute_usd / runner.vcpu);
      };
      return [
        smallest("linux", "linux-x64"),
        smallest("arm", "linux-arm64"),
        smallest("windows", "windows"),
        smallest("macos", "macos"),
      ];
    },
  },
  {
    provider: "ubicloud",
    url: "https://raw.githubusercontent.com/ubicloud/ubicloud/main/config/billing_rates/github.yml",
    page: "https://github.com/ubicloud/ubicloud/blob/main/config/billing_rates/github.yml",
    // The rates Ubicloud bills by, one dated line each. 2-vCPU runners set the per-vCPU rate.
    parse(yml) {
      const families: Record<string, string> = { "standard-2": "standard", "premium-2": "premium" };
      const prices: FoundPrice[] = [];
      for (const line of yml.split("\n")) {
        if (!line.includes("GitHubRunnerMinutes")) continue;
        const fields = Object.fromEntries(
          [...line.matchAll(/(\w+): ([^,}\s]+)/g)].map((match) => [match[1], match[2]]),
        );
        if (fields.location !== "global" || fields.byoc === "true") continue;
        const rate = families[fields.resource_family ?? ""];
        const from = fields.active_from?.slice(0, 10);
        if (!rate || !from) continue;
        prices.push(found(rate, Number(fields.unit_price) / 2, from));
      }
      if (!prices.some((p) => p.rate === "standard") || !prices.some((p) => p.rate === "premium"))
        throw new Error("standard-2 or premium-2 not found");
      return prices;
    },
  },
  {
    provider: "github",
    url: "https://docs.github.com/api/article/body?pathname=/en/billing/reference/actions-runner-pricing",
    page: "https://docs.github.com/en/billing/reference/actions-runner-pricing",
    // The standard runners table, by billing SKU.
    parse(md) {
      const sku = (rate: string, name: string) =>
        found(rate, priceCell(tableRow(md, (cell) => cell === `\`${name}\``)));
      return [
        sku("linux-1-core", "actions_linux_slim"),
        sku("linux-2-core", "actions_linux"),
        sku("linux-arm-2-core", "actions_linux_arm"),
        sku("windows-2-core", "actions_windows"),
        sku("windows-arm-2-core", "actions_windows_arm"),
        sku("macos", "actions_macos"),
      ];
    },
  },
];
