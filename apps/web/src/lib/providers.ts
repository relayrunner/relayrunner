import {
  BASE_BOOK,
  githubRate,
  listRate,
  PRICES_CHECKED,
  type ProviderId,
  type RatePrices,
  ratePrices,
} from "@relayrunner/providers";
import { api } from "@/lib/api";
import { type Environment, type Stat, sampleStat } from "@/lib/job-times";
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

export type ProviderSummary = ProviderCounts & { provider: string; stat: Stat };

/** The Providers page (GET /api/providers): every provider the workspace's jobs ran on. */
export type ProvidersOverview = {
  days: number;
  pricesChecked: string;
  providers: ProviderSummary[];
};

export function getProviderReport(provider: string, days: number) {
  return api<ProviderReport>(`/providers/${provider}?days=${days}`);
}

export function getProvidersOverview(days: number) {
  return api<ProvidersOverview>(`/providers?days=${days}`);
}

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
  return {
    key: `${provider}:${label}`,
    label,
    detail,
    jobs,
    failures: Math.round(jobs * 0.03),
    billedMinutes,
    perMinute,
    cost: perMinute === null ? 0 : cents(billedMinutes * perMinute),
    unpricedJobs: perMinute === null ? jobs : 0,
    stat: sampleStat(medianS, jobs),
  };
}

const SAMPLE_RUNNERS: Partial<Record<ProviderId, ProviderRunner[]>> = {
  blacksmith: [
    sampleRunner("blacksmith", "blacksmith-4vcpu-ubuntu-2404", "Blacksmith", 872, 228),
    sampleRunner("blacksmith", "blacksmith-8vcpu-ubuntu-2404", "Blacksmith", 281, 365),
  ],
  github: [sampleRunner("github", "Linux 2-core", "GitHub-hosted", 410, 128)],
  other: [sampleRunner("other", "gpu-runner", "Default", 57, 302)],
};

function sampleTotals(list: ProviderRunner[]): ProviderCounts & { stat: Stat } {
  const jobs = sum(list, (r) => r.jobs);
  return {
    jobs,
    failures: sum(list, (r) => r.failures),
    billedMinutes: sum(list, (r) => r.billedMinutes),
    cost: cents(sum(list, (r) => r.cost)),
    unpricedJobs: sum(list, (r) => r.unpricedJobs),
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

export function sampleProvidersOverview(days: number): ProvidersOverview {
  const providers = Object.entries(SAMPLE_RUNNERS)
    .map(([provider, runners]) => ({ provider: provider as ProviderId, ...sampleTotals(runners) }))
    .sort((a, b) => b.jobs - a.jobs);
  return { days, pricesChecked: PRICES_CHECKED, providers };
}
