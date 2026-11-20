import { api } from "@/lib/api";
import { rangeQuery, type TimeRange } from "@/lib/time-range";

/** One GitHub rate's jobs in the usage report (GET /api/usage). Money is USD. */
export type UsageRow = {
  runnerClass: string;
  label: string;
  /** USD per minute in a private repo. */
  perMinute: number;
  jobs: number;
  shortJobs: number;
  runSeconds: number;
  billedMinutes: number;
  shortBilledMinutes: number;
  cost: number;
  shortCost: number;
  roundingCost: number;
};

/** What the free checks saved (GET /api/usage/checks): a billed minute per check or lint run. */
export type FreeCheckSavings = {
  days: number;
  /** The runner and rate each check is priced at. */
  runner: { label: string; perMinute: number };
  /** Check runs, each one billed minute saved, public repos included. */
  checks: number;
  /** USD, after free public-repo minutes. */
  savedCost: number;
  /** Each kind of check ("PR title", "Lint"), the most runs first. */
  byCheck: { check: string; checks: number; savedCost: number }[];
  byRepository: {
    repository: string;
    private: boolean | null;
    checks: number;
    savedCost: number;
  }[];
};

export type UsageReport = {
  days: number;
  shortJobSeconds: number;
  totals: Omit<UsageRow, "runnerClass" | "label" | "perMinute">;
  byRunner: UsageRow[];
  byRepository: {
    repository: string;
    private: boolean | null;
    jobs: number;
    shortJobs: number;
    shortCost: number;
  }[];
};

/** The workspace's finished jobs in a range. */
export function getUsage(range: TimeRange) {
  return api<UsageReport>(`/usage?${rangeQuery(range)}`);
}

/** The free checks' savings in a range. */
export function getCheckSavings(range: TimeRange) {
  return api<FreeCheckSavings>(`/usage/checks?${rangeQuery(range)}`);
}

/** Example savings for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleCheckSavings(days: number): FreeCheckSavings {
  const perMinute = 0.006;
  const title = Math.round(110 * (days / 30));
  const lint = Math.round(90 * (days / 30));
  // PR title checks in both repos, lint only in acme/app.
  const docs = Math.round(title * 0.55);
  const app = title - docs + lint;
  return {
    days,
    runner: { label: "ubuntu-latest", perMinute },
    checks: title + lint,
    savedCost: app * perMinute,
    byCheck: [
      { check: "PR title", checks: title, savedCost: (title - docs) * perMinute },
      { check: "Lint", checks: lint, savedCost: lint * perMinute },
    ],
    byRepository: [
      { repository: "acme/app", private: true, checks: app, savedCost: app * perMinute },
      { repository: "acme/docs", private: false, checks: docs, savedCost: 0 },
    ],
  };
}

/** "$0.074" under a dollar (a minute can cost $0.002), "$12.40" above. */
export function money(usd: number) {
  return usd > 0 && usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** "142" or "1,204" minutes. */
export function minutes(value: number) {
  return Math.round(value).toLocaleString();
}
