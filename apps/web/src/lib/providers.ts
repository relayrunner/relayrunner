import { type RatePrices, priceBook, runnerCatalog } from "@relayrunner/providers";
import { api } from "@/lib/api";
import type { Environment, Stat } from "@/lib/job-times";
import {
  type RangeOptions,
  rangeQuery,
  reportQuery,
  resolveRange,
  type TimeRange,
} from "@/lib/time-range";
import { startOfDay, startOfHours, startOfWeek } from "@/lib/time-zone";
import { money } from "@/lib/usage";
/** How a provider page shows its machine prices (components/machine-prices.tsx). */
export const PRICE_VIEWS = [
  { value: "grid", label: "Grid" },
  { value: "chart", label: "Chart" },
] as const;
export type PriceView = (typeof PRICE_VIEWS)[number]["value"];

export type ProviderCounts = {
  jobs: number;
  failures: number;
  /** Minutes after rounding each job up. */
  billedMinutes: number;
  /** Estimated USD at list price, for the jobs on runner types with a known price. */
  cost: number;
  /** Jobs on runner types without a known price, left out of `cost`. */
  unpricedJobs: number;
  /** Jobs with a known wait between queued and started. */
  waits: number;
  /** Of those, the jobs a runner started within a minute. */
  quickStarts: number;
  /** Failed jobs the runner gave up on before any step ran. */
  runnerFailures: number;
};

export type ProviderRunner = Environment &
  ProviderCounts & { stat: Stat; perMinute: number | null };

export type ProviderWorkflow = { repository: string; workflow: string; jobs: number };

/** A provider's page (GET /api/providers/:provider): the workspace's jobs on it. */
export type ProviderReport = ProviderCounts & {
  provider: string;
  days: number;
  pricesChecked: string;
  stat: Stat;
  runners: ProviderRunner[];
  workflows: ProviderWorkflow[];
  /** The provider's list prices, each with its history. Empty when it has none. */
  prices: RatePrices[];
};

export type ProviderSummary = ProviderCounts & {
  provider: string;
  stat: Stat;
  /** Its runner types, busiest first. */
  runners: ProviderRunner[];
  /** Billed minutes in the window the trend compares with, or null when there's no trend. */
  priorBilledMinutes: number | null;
};

/** Billed minutes per provider in one hour, day or week of the window. */
export type ShareBucket = { start: number; minutes: Record<string, number> };

/** The Providers page (GET /api/providers): every provider the workspace's jobs ran on. */
export type ProvidersOverview = {
  days: number;
  pricesChecked: string;
  providers: ProviderSummary[];
  /** An hour when asked over two days or less, a day, or a week when asked or past a month. */
  bucketMs: number;
  /** Each provider's billed minutes over the window, oldest first. */
  buckets: ShareBucket[];
};

/**
 * The ranges the provider pages and the Runners page's cloud table offer: as far back as the API
 * keeps each job (two months), starting on this month since that's when plans' minutes reset.
 */
export const PROVIDER_RANGES: RangeOptions = {
  presets: ["24h", "7d", "14d", "30d", "week", "lastweek", "month", "lastmonth"],
};
export const PROVIDER_DEFAULT_RANGE: TimeRange = "month";

export function getProviderReport(provider: string, range: TimeRange) {
  return api<ProviderReport>(`/providers/${provider}?${rangeQuery(range)}`);
}

/** How long each bar of the Providers page's minutes chart is. */
export type ChartPer = "hour" | "day" | "week";

/** The start of the bar `ms` falls in: the reader's hour, midnight, or start of their week. */
export const barStart = (per: ChartPer, ms: number) =>
  per === "hour" ? startOfHours(ms) : per === "week" ? startOfWeek(ms) : startOfDay(ms);

/**
 * Every provider the workspace's jobs ran on. With `chart`, also each one's minutes an hour, a day
 * or a week at a time from the reader's hour, midnight or start of their week, even for a rolling
 * range, and over the window before.
 */
export function getProvidersOverview(range: TimeRange, { chart }: { chart?: ChartPer } = {}) {
  if (!chart) return api<ProvidersOverview>(`/providers?${rangeQuery(range)}`);
  const { from } = resolveRange(range);
  const query = reportQuery(range, {
    origin: String(barStart(chart, from)),
    ...(chart !== "day" && { per: chart }),
  });
  return api<ProvidersOverview>(`/providers?${query}`);
}

/** The share of a runner type's jobs it started within a minute, or null when none had a wait. */
export const quickShare = ({ waits, quickStarts }: ProviderCounts) =>
  waits > 0 ? quickStarts / waits : null;

/** The estimated cost, or "—" when none of the jobs had a price. */
export const costText = ({ cost, jobs, unpricedJobs }: ProviderCounts) =>
  jobs > 0 && unpricedJobs === jobs ? "—" : money(cost);

export { rateName, rateText } from "@relayrunner/providers";

/** Every runner the provider sells, by system, priced from the report's list prices. */
export function reportCatalog({ provider, prices }: ProviderReport) {
  const rows = prices.flatMap(({ rate, history }) =>
    history.map(({ usd, from }) => ({ provider, rate, usd, from })),
  );
  return runnerCatalog(priceBook(rows), provider);
}
