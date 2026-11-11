import type { ProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";
import { type Environment, type Stat, sampleStat } from "@/lib/job-times";

export type ProviderCounts = { jobs: number; failures: number; runSeconds: number };

export type ProviderRunner = Environment & ProviderCounts & { stat: Stat };

/** A provider's page (GET /api/providers/:provider): the workspace's jobs on it. */
export type ProviderReport = ProviderCounts & {
  provider: ProviderId;
  days: number;
  stat: Stat;
  runners: ProviderRunner[];
};

export function getProviderReport(provider: ProviderId, days: number) {
  return api<ProviderReport>(`/providers/${provider}?days=${days}`);
}

// A sample runner type: `jobs` jobs around `medianS` seconds, 3% of them failed.
function sampleRunner(
  provider: string,
  label: string,
  detail: string,
  jobs: number,
  medianS: number,
) {
  return {
    key: `${provider}:${label}`,
    label,
    detail,
    jobs,
    failures: Math.round(jobs * 0.03),
    runSeconds: jobs * medianS,
    stat: sampleStat(medianS, jobs),
  };
}

/** Made-up numbers for the dev server with auth off. Only Blacksmith and GitHub have jobs. */
export function sampleProviderReport(provider: ProviderId, days: number): ProviderReport {
  const runners: Partial<Record<ProviderId, ProviderRunner[]>> = {
    blacksmith: [
      sampleRunner("blacksmith", "blacksmith-4vcpu-ubuntu-2404", "Blacksmith", 872, 228),
      sampleRunner("blacksmith", "blacksmith-8vcpu-ubuntu-2404", "Blacksmith", 281, 365),
    ],
    github: [sampleRunner("github", "Linux 2-core", "GitHub-hosted", 410, 128)],
  };
  const list = runners[provider] ?? [];
  const sum = (pick: (r: ProviderRunner) => number) => list.reduce((n, r) => n + pick(r), 0);
  const jobs = sum((r) => r.jobs);
  return {
    provider,
    days,
    jobs,
    failures: sum((r) => r.failures),
    runSeconds: sum((r) => r.runSeconds),
    stat: sampleStat(list[0] ? (list[0].stat.medianMs ?? 0) / 1000 : 0, jobs),
    runners: list,
  };
}
