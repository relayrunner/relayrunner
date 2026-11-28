import { api } from "./api";
import { interpolate } from "./chart-trend";
import { type Sort, sortOf, sortParam, unlessDefault } from "./search-params";
import { type RangeOptions, rangeQuery, type TimeRange } from "./time-range";

/** One pull request's CI in GET /api/usage/pull-requests. Minutes are run time; money is USD. */
export type PullRequestMinutes = {
  repository: string;
  number: number;
  title: string | null;
  minutes: number;
  /** The part of `minutes` from re-runs (attempt 2 and up). */
  rerunMinutes: number;
  cost: number;
  commits: number;
  /** When it opened, merged and closed, epoch ms. Null when not, or not known. */
  openedAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  /** When its first job in the range started, epoch ms. */
  firstRunAt: number;
};

export type PullRequestReport = {
  /** The most minutes first. */
  pullRequests: PullRequestMinutes[];
  /** Minutes of jobs no pull request was found for, per repo. */
  outside: { repository: string; minutes: number }[];
};

/** The view reads jobs' own rows, which the API keeps 62 days, so it has no 90-day range. */
export const PULL_REQUEST_RANGES: RangeOptions = {
  presets: ["7d", "14d", "30d", "week", "lastweek", "month", "lastmonth"],
};

// The table columns `?sort=` can name, and its sort without one: the most minutes first.
const SORTABLE = ["number", "date", "minutes", "rerunMinutes", "commits", "cost"];
export const DEFAULT_PULL_REQUEST_SORT: Sort = { id: "minutes", desc: true };

/** The Pull requests table's sort as its `?sort=`: nothing for the default or what it can't sort by. */
export function pullRequestSortParam(value: unknown) {
  const sort = sortOf(value, SORTABLE);
  return sort && unlessDefault(sortParam(sort), sortParam(DEFAULT_PULL_REQUEST_SORT));
}

/** The Pull requests table's sort from its `?sort=`. */
export const pullRequestSortOf = (value: unknown) =>
  sortOf(value, SORTABLE) ?? DEFAULT_PULL_REQUEST_SORT;

export function getPullRequests(range: TimeRange) {
  return api<PullRequestReport>(`/usage/pull-requests?${rangeQuery(range)}`);
}

/**
 * The date the table shows and sorts by, and what it is: when it merged, or when it opened while
 * it hasn't. For a pull request RelayRunner hasn't seen open, its first job in the range stands in.
 */
export function datedAs(pr: PullRequestMinutes) {
  if (pr.mergedAt !== null) return { label: "Merged", at: pr.mergedAt };
  if (pr.openedAt !== null) return { label: "Opened", at: pr.openedAt };
  return { label: "First CI run", at: pr.firstRunAt };
}

export const dateOf = (pr: PullRequestMinutes) => datedAs(pr).at;

/** Merged, closed without merging, or open (or not known: shown as open). */
export const stateOf = (pr: PullRequestMinutes) =>
  pr.mergedAt !== null ? "merged" : pr.closedAt !== null ? "closed" : "open";

const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

/** The median and p90 of some values, their mean and their sum. Zeros when there are none. */
export function spreadOf(values: number[]) {
  if (!values.length) return { median: 0, p90: 0, average: 0, total: 0 };
  const sorted = values.toSorted((a, b) => a - b);
  const sum = total(sorted);
  return {
    median: interpolate(sorted, 0.5),
    p90: interpolate(sorted, 0.9),
    average: sum / sorted.length,
    total: sum,
  };
}

/** What the view's tiles show, for the pull requests and other jobs a repo filter keeps. */
export function summarize(
  pullRequests: PullRequestMinutes[],
  outside: PullRequestReport["outside"],
) {
  const minutes = spreadOf(pullRequests.map((pr) => pr.minutes));
  const allMinutes = minutes.total + total(outside.map((row) => row.minutes));
  return {
    count: pullRequests.length,
    minutes,
    cost: spreadOf(pullRequests.map((pr) => pr.cost)),
    /** Of all the jobs' minutes, the share that ran for pull requests. */
    prShare: allMinutes ? minutes.total / allMinutes : 0,
    /** Of the pull requests' minutes, the share from re-runs. */
    rerunShare: minutes.total
      ? total(pullRequests.map((pr) => pr.rerunMinutes)) / minutes.total
      : 0,
  };
}

// Round minute edges for the pull request bars, never hours.
const LADDER = [1, 2, 5, 10, 20, 30, 60, 120, 240, 480, 960, 1920];
// The most edges the bars split at, so they stay readable on a phone.
const MAX_EDGES = 7;

/** One bar: pull requests from `from` minutes up to `to` (null: and up). */
export type MinuteBucket = { from: number; to: number | null; count: number; minutes: number };

/**
 * Pull requests' minutes in bars at round edges that span the middle of the spread: from about
 * the 10th to the 95th percentile, so one huge pull request doesn't squash the rest into a bar.
 */
export function minuteBuckets(values: number[]): MinuteBucket[] {
  if (!values.length) return [];
  const sorted = values.toSorted((a, b) => a - b);
  const low = interpolate(sorted, 0.1);
  const high = interpolate(sorted, 0.95);
  const first = LADDER.findLastIndex((edge) => edge <= low);
  const last = LADDER.findIndex((edge) => edge >= high);
  // Past the most edges, the smallest go: the long pull requests are where the minutes are.
  const edges = LADDER.slice(Math.max(first, 0), last < 0 ? undefined : last + 1).slice(-MAX_EDGES);
  const buckets: MinuteBucket[] = [0, ...edges].map((from, i) => ({
    from,
    to: edges[i] ?? null,
    count: 0,
    minutes: 0,
  }));
  for (const value of sorted) {
    const bucket = buckets.find((b) => b.to === null || value < b.to)!;
    bucket.count += 1;
    bucket.minutes += value;
  }
  return buckets;
}

/** Where `value` falls across the bars, in bars from the left edge (2.5 is mid third bar). */
export function bucketPosition(buckets: MinuteBucket[], value: number) {
  const i = buckets.findIndex((b) => b.to === null || value < b.to);
  if (i < 0) return buckets.length;
  const { from, to } = buckets[i]!;
  return i + (to === null ? 0.5 : (value - from) / (to - from));
}
