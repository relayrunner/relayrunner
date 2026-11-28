import { api } from "@/lib/api";
import { rangeQuery, type TimeRange } from "@/lib/time-range";
import { filterQuery, type RunFilters } from "./run-filters.ts";

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
  /**
   * Jobs by how long they ran, shortest first: under `under` seconds (the last, null, the rest).
   * Only covers the jobs the API keeps one by one, the last 62 days.
   */
  lengths: { under: number | null; jobs: number }[];
};

/** The workspace's finished jobs in a range. */
export function getUsage(range: TimeRange, filters: RunFilters = {}) {
  const filter = new URLSearchParams(filterQuery(filters)).toString();
  return api<UsageReport>(`/usage?${rangeQuery(range)}${filter && `&${filter}`}`);
}

/** The free checks' savings in a range. */
export function getCheckSavings(range: TimeRange) {
  return api<FreeCheckSavings>(`/usage/checks?${rangeQuery(range)}`);
}

/** "$0.074" under a dollar (a minute can cost $0.002), "$12.40" above. */
export function money(usd: number) {
  return usd > 0 && usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** "142" or "1,204" minutes. */
export function minutes(value: number) {
  return Math.round(value).toLocaleString();
}
