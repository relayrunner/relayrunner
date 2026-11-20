import {
  BASE_BOOK,
  githubRate,
  listRate,
  PRICES_CHECKED,
  type ProviderId,
  type RatePrices,
  priceBook,
  ratePrices,
  runnerCatalog,
  runnerSize,
} from "@relayrunner/providers";
import { api } from "@/lib/api";
import { type Environment, type Stat, sampleStat } from "@/lib/job-times";
import {
  type RangeOptions,
  rangeQuery,
  reportQuery,
  resolveRange,
  type TimeRange,
} from "@/lib/time-range";
import { startOfDay } from "@/lib/time-zone";
import { money } from "@/lib/usage";

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

/** Billed minutes per provider in one day (or week) of the window. */
export type ShareBucket = { start: number; minutes: Record<string, number> };

/** The Providers page (GET /api/providers): every provider the workspace's jobs ran on. */
export type ProvidersOverview = {
  days: number;
  pricesChecked: string;
  providers: ProviderSummary[];
  /** A day, or a week past a month. */
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

// The chart's days start at the reader's midnight, even for a rolling range.
export function getProvidersOverview(range: TimeRange) {
  const query = reportQuery(range, {
    origin: String(startOfDay(resolveRange(range).from)),
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

const cents = (usd: number) => Math.round(usd * 1000) / 1000;

const sum = <T>(list: T[], pick: (item: T) => number) => list.reduce((n, x) => n + pick(x), 0);

// A sample runner type: `jobs` jobs around `medianS` seconds, 3% of them failed.
function sampleRunner(
  provider: ProviderId,
  label: string,
  detail: string,
  jobs: number,
  medianS: number,
): ProviderRunner {
  const billedMinutes = jobs * Math.ceil(medianS / 60);
  const perMinute =
    provider === "github"
      ? githubRate(BASE_BOOK, "linux-2-core")
      : listRate(BASE_BOOK, provider, label);
  const size = runnerSize(provider, provider === "github" ? "linux-2-core" : label);
  return {
    // The API keys GitHub runners by their rate.
    key: `${provider}:${provider === "github" ? "linux-2-core" : label}`,
    label,
    detail,
    ...(size && { size }),
    jobs,
    failures: Math.round(jobs * 0.03),
    billedMinutes,
    waits: jobs,
    // Machines you host start everything at once; clouds start most jobs within a minute.
    quickStarts: Math.round(jobs * (provider === "github" ? 0.97 : 0.92)),
    runnerFailures: Math.round(jobs * (provider === "github" ? 0 : 0.004)),
    perMinute,
    cost: perMinute === null ? 0 : cents(billedMinutes * perMinute),
    unpricedJobs: perMinute === null ? jobs : 0,
    stat: sampleStat(medianS, jobs),
  };
}

const SAMPLE_RUNNERS: Partial<Record<ProviderId, ProviderRunner[]>> = {
  blacksmith: [
    sampleRunner("blacksmith", "blacksmith-4vcpu-ubuntu-2404", "Blacksmith", 872, 228),
    sampleRunner("blacksmith", "blacksmith-2vcpu-ubuntu-2404", "Blacksmith", 410, 130),
    sampleRunner("blacksmith", "blacksmith-8vcpu-ubuntu-2404", "Blacksmith", 281, 365),
    sampleRunner("blacksmith", "blacksmith-16vcpu-ubuntu-2404-arm", "Blacksmith", 40, 552),
  ],
  github: [sampleRunner("github", "ubuntu-latest", "GitHub-hosted", 410, 128)],
  depot: [sampleRunner("depot", "depot-ubuntu-24.04", "Depot", 96, 400)],
  ubicloud: [sampleRunner("ubicloud", "ubicloud-standard-2", "Ubicloud", 174, 332)],
  other: [sampleRunner("other", "gpu-runner", "Self-hosted", 57, 302)],
};

function sampleTotals(list: ProviderRunner[]): ProviderCounts & { stat: Stat } {
  const jobs = sum(list, (r) => r.jobs);
  return {
    jobs,
    failures: sum(list, (r) => r.failures),
    billedMinutes: sum(list, (r) => r.billedMinutes),
    cost: cents(sum(list, (r) => r.cost)),
    unpricedJobs: sum(list, (r) => r.unpricedJobs),
    waits: sum(list, (r) => r.waits),
    quickStarts: sum(list, (r) => r.quickStarts),
    runnerFailures: sum(list, (r) => r.runnerFailures),
    stat: sampleStat(list[0] ? (list[0].stat.medianMs ?? 0) / 1000 : 0, jobs),
  };
}

/** Made-up numbers for the dev server with auth off. Only a few providers have jobs. */
export function sampleProviderReport(provider: string, days: number): ProviderReport {
  const runners = SAMPLE_RUNNERS[provider as ProviderId] ?? [];
  const total = sampleTotals(runners);
  const workflows = [
    { repository: "acme/web", workflow: "CI", jobs: Math.round(total.jobs * 0.48) },
    { repository: "acme/api", workflow: "Test", jobs: Math.round(total.jobs * 0.31) },
    { repository: "acme/cli", workflow: "Release", jobs: Math.round(total.jobs * 0.13) },
  ].filter((w) => w.jobs > 0);
  return {
    provider,
    days,
    pricesChecked: PRICES_CHECKED,
    ...total,
    runners,
    workflows,
    prices: ratePrices(BASE_BOOK, provider),
  };
}

// How a sample provider's share drifts over the window: Blacksmith takes over from GitHub.
const SAMPLE_DRIFT: Partial<Record<ProviderId, number>> = { blacksmith: 0.6, github: -0.5 };

export function sampleProvidersOverview(days: number, now = Date.now()): ProvidersOverview {
  const providers = Object.entries(SAMPLE_RUNNERS)
    .map(([provider, runners]) => {
      const totals = sampleTotals(runners);
      const drift = SAMPLE_DRIFT[provider as ProviderId] ?? 0;
      return {
        provider: provider as ProviderId,
        ...totals,
        runners,
        priorBilledMinutes: Math.round(totals.billedMinutes * (1 - drift / 2)),
      };
    })
    .sort((a, b) => b.jobs - a.jobs);
  const DAY_MS = 86_400_000;
  const bucketMs = days > 31 ? 7 * DAY_MS : DAY_MS;
  const count = Math.max(1, Math.ceil((days * DAY_MS) / bucketMs));
  const origin = startOfDay(now - (count - 1) * bucketMs);
  const buckets = Array.from({ length: count }, (_, i) => {
    const at = count === 1 ? 1 : i / (count - 1);
    // Weekends are quiet.
    const weekday = new Date(origin + i * bucketMs).getDay();
    const quiet = bucketMs === DAY_MS && (weekday === 0 || weekday === 6) ? 0.3 : 1;
    return {
      start: origin + i * bucketMs,
      minutes: Object.fromEntries(
        providers.map((p) => {
          const drift = SAMPLE_DRIFT[p.provider] ?? 0;
          const wobble = 0.85 + 0.3 * Math.abs(Math.sin((i + 1) * (p.jobs % 7)));
          const share = (1 + drift * (at - 0.5)) * wobble * quiet;
          return [p.provider, Math.round((p.billedMinutes / count) * share)];
        }),
      ),
    };
  });
  return { days, pricesChecked: PRICES_CHECKED, providers, bucketMs, buckets };
}

/** Every runner the provider sells, by system, priced from the report's list prices. */
export function reportCatalog({ provider, prices }: ProviderReport) {
  const rows = prices.flatMap(({ rate, history }) =>
    history.map(({ usd, from }) => ({ provider, rate, usd, from })),
  );
  return runnerCatalog(priceBook(rows), provider);
}
