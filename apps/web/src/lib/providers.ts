import { listRate, PRICES_CHECKED, type ProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";
import { type Environment, type Stat, sampleStat } from "@/lib/job-times";

export type ProviderCounts = {
  jobs: number;
  failures: number;
  runSeconds: number;
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
  provider: ProviderId;
  days: number;
  pricesChecked: string;
  stat: Stat;
  runners: ProviderRunner[];
  workflows: ProviderWorkflow[];
};

export type ProviderSummary = ProviderCounts & { provider: ProviderId; stat: Stat };

/** The Providers page (GET /api/providers): every provider the workspace's jobs ran on. */
export type ProvidersOverview = {
  days: number;
  pricesChecked: string;
  providers: ProviderSummary[];
};

export function getProviderReport(provider: ProviderId, days: number) {
  return api<ProviderReport>(`/providers/${provider}?days=${days}`);
}

export function getProvidersOverview(days: number) {
  return api<ProvidersOverview>(`/providers?days=${days}`);
}

/** "$75.30", or "—" when nothing had a price; sub-cent amounts keep a third digit. */
export function costText({ cost, jobs, unpricedJobs }: ProviderCounts) {
  if (jobs > 0 && unpricedJobs === jobs) return "—";
  return cost.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: cost > 0 && cost < 1 ? 3 : 2,
  });
}

/** "$0.008/min", or "—" without a known price. */
export const rateText = (perMinute: number | null) =>
  perMinute === null ? "—" : `$${Number(perMinute.toFixed(5))}/min`;

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
  const perMinute = provider === "github" ? 0.006 : listRate(provider, label);
  return {
    key: `${provider}:${label}`,
    label,
    detail,
    jobs,
    failures: Math.round(jobs * 0.03),
    runSeconds: jobs * medianS,
    billedMinutes,
    perMinute,
    cost: perMinute === null ? 0 : Math.round(billedMinutes * perMinute * 1000) / 1000,
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
    runSeconds: sum(list, (r) => r.runSeconds),
    billedMinutes: sum(list, (r) => r.billedMinutes),
    cost: Math.round(sum(list, (r) => r.cost) * 1000) / 1000,
    unpricedJobs: sum(list, (r) => r.unpricedJobs),
    stat: sampleStat(list[0] ? (list[0].stat.medianMs ?? 0) / 1000 : 0, jobs),
  };
}

/** Made-up numbers for the dev server with auth off. Only a few providers have jobs. */
export function sampleProviderReport(provider: ProviderId, days: number): ProviderReport {
  const runners = SAMPLE_RUNNERS[provider] ?? [];
  const total = sampleTotals(runners);
  const workflows = [
    { repository: "acme/web", workflow: "CI", jobs: Math.round(total.jobs * 0.48) },
    { repository: "acme/api", workflow: "Test", jobs: Math.round(total.jobs * 0.31) },
    { repository: "acme/cli", workflow: "Release", jobs: Math.round(total.jobs * 0.13) },
  ].filter((w) => w.jobs > 0);
  return { provider, days, pricesChecked: PRICES_CHECKED, ...total, runners, workflows };
}

export function sampleProvidersOverview(days: number): ProvidersOverview {
  const providers = Object.entries(SAMPLE_RUNNERS)
    .map(([provider, runners]) => ({ provider: provider as ProviderId, ...sampleTotals(runners) }))
    .sort((a, b) => b.jobs - a.jobs);
  return { days, pricesChecked: PRICES_CHECKED, providers };
}
