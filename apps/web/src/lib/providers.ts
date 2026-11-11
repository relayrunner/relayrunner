import type { ProviderId } from "@relayrunner/providers";
import { api } from "@/lib/api";
import type { Environment, Stat } from "@/lib/job-times";

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

function sampleStat(runs: number, medianMs: number): Stat {
  return {
    runs,
    successes: runs - 1,
    samples: Math.min(runs - 1, 50),
    confidence: "ok",
    medianMs,
    p25Ms: Math.round(medianMs * 0.8),
    p75Ms: Math.round(medianMs * 1.3),
    p90Ms: Math.round(medianMs * 1.6),
    waitMs: 6000,
    trend: null,
  };
}

/** Made-up numbers for the dev server with auth off. Only Blacksmith and GitHub have jobs. */
export function sampleProviderReport(provider: ProviderId, days: number): ProviderReport {
  const runners: Record<string, ProviderRunner[]> = {
    blacksmith: [
      {
        key: "blacksmith:blacksmith-4vcpu-ubuntu-2404",
        label: "blacksmith-4vcpu-ubuntu-2404",
        detail: "Blacksmith",
        jobs: 872,
        failures: 27,
        runSeconds: 198_816,
        stat: sampleStat(872, 228_000),
      },
      {
        key: "blacksmith:blacksmith-8vcpu-ubuntu-2404",
        label: "blacksmith-8vcpu-ubuntu-2404",
        detail: "Blacksmith",
        jobs: 281,
        failures: 13,
        runSeconds: 102_565,
        stat: sampleStat(281, 365_000),
      },
    ],
    github: [
      {
        key: "github:linux-2-core",
        label: "Linux 2-core",
        detail: "GitHub-hosted",
        jobs: 410,
        failures: 9,
        runSeconds: 52_480,
        stat: sampleStat(410, 128_000),
      },
    ],
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
    stat: jobs ? sampleStat(jobs, list[0]?.stat.medianMs ?? 0) : emptyStat(),
    runners: list,
  };
}

function emptyStat(): Stat {
  return {
    runs: 0,
    successes: 0,
    samples: 0,
    confidence: "none",
    medianMs: null,
    p25Ms: null,
    p75Ms: null,
    p90Ms: null,
    waitMs: null,
    trend: null,
  };
}
