// Provider reports for the dev preview (lib/sample/answers.ts), like GET /api/providers and
// /api/providers/:provider.
import {
  BASE_BOOK,
  githubRate,
  listRate,
  PRICES_CHECKED,
  type ProviderId,
  ratePrices,
  runnerSize,
} from "@relayrunner/providers";
import { DAY_MS, type Stat } from "../job-times";
import {
  type ChartPer,
  type ProviderCounts,
  type ProviderReport,
  type ProviderRunner,
  type ProvidersOverview,
  barStart,
} from "../providers.ts";
import { sampleStat } from "./job-times.ts";

const HOUR_MS = 3_600_000;

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

export function sampleProvidersOverview(
  days: number,
  { now = Date.now(), per = "day" }: { now?: number; per?: ChartPer } = {},
): ProvidersOverview {
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
  const hourly = per === "hour" && days <= 2;
  const bucketMs = hourly ? HOUR_MS : per === "week" || days > 31 ? 7 * DAY_MS : DAY_MS;
  const count = Math.max(1, Math.ceil((days * DAY_MS) / bucketMs));
  const origin = barStart(
    hourly ? "hour" : bucketMs > DAY_MS ? "week" : "day",
    now - (count - 1) * bucketMs,
  );
  const buckets = Array.from({ length: count }, (_, i) => {
    const at = count === 1 ? 1 : i / (count - 1);
    // Weekends, and nights, are quiet.
    const when = new Date(origin + i * bucketMs);
    const weekday = when.getDay();
    const hour = when.getHours();
    const night = hourly && (hour < 8 || hour >= 20);
    const weekend = bucketMs === DAY_MS && (weekday === 0 || weekday === 6);
    const quiet = night ? 0.2 : weekend ? 0.3 : 1;
    // Volume grows over the window, so weekly bars show a trend.
    const growth = 0.8 + 0.4 * at;
    return {
      start: origin + i * bucketMs,
      minutes: Object.fromEntries(
        providers.map((p) => {
          const drift = SAMPLE_DRIFT[p.provider] ?? 0;
          const wobble = 0.85 + 0.3 * Math.abs(Math.sin((i + 1) * (p.jobs % 7)));
          const share = (1 + drift * (at - 0.5)) * wobble * quiet;
          return [p.provider, Math.round((p.billedMinutes / count) * share * growth)];
        }),
      ),
    };
  });
  return { days, pricesChecked: PRICES_CHECKED, providers, bucketMs, buckets };
}
