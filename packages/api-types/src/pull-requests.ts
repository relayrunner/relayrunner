import { interpolate } from "./job-times.ts";

// GET /api/usage/pull-requests (apps/api/src/reports/pull-request-minutes.ts): CI minutes per pull
// request, shared with the dashboard's Usage › Pull requests view and the MCP server.

/** One pull request's CI in the range. Minutes are run time; money is USD. */
export interface PullRequestMinutes {
  repository: string;
  number: number;
  /** The title of the newest run that named the pull request. */
  title: string | null;
  /** Time its jobs ran, and the part of it from re-runs (attempt 2 and up). */
  minutes: number;
  rerunMinutes: number;
  /** Estimated USD after GitHub rounds each job up to a minute, less free public-repo minutes. */
  cost: number;
  /** Distinct commits that ran. */
  commits: number;
  /** When it opened, merged and closed, epoch ms. Null when not, or not known. */
  openedAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  /** When its first job in the range started, epoch ms. */
  firstRunAt: number;
}

/** The median and p90 of some values, their mean and their sum. Zeros when there are none. */
export interface Spread {
  median: number;
  p90: number;
  average: number;
  total: number;
}

/** One bar of the minutes spread: pull requests from `from` minutes up to `to` (null: and up). */
export interface MinuteBucket {
  from: number;
  to: number | null;
  count: number;
  minutes: number;
}

export interface PullRequestReport {
  /** Every pull request in the range (in the repo, when one is asked for), summed up. */
  summary: {
    count: number;
    minutes: Spread;
    cost: Spread;
    /** Of all the jobs' minutes, the share that ran for pull requests. */
    prShare: number;
    /** Of the pull requests' minutes, the share from re-runs. */
    rerunShare: number;
    /** How many pull requests used how many minutes, at round edges. */
    buckets: MinuteBucket[];
  };
  /** One page of the pull requests, in the order asked for. */
  pullRequests: PullRequestMinutes[];
  /** Minutes of jobs no pull request could be found for, per repo. */
  outside: { repository: string; minutes: number }[];
  /** Every repo that ran jobs in the range, for picking one. */
  repositories: string[];
}

/**
 * The date a pull request shows and sorts by, and what it is: when it merged, or when it opened
 * while it hasn't. For one with no opened date known, its first job in the range stands in.
 */
export function pullRequestDate(pr: PullRequestMinutes) {
  if (pr.mergedAt !== null) return { label: "Merged", at: pr.mergedAt };
  if (pr.openedAt !== null) return { label: "Opened", at: pr.openedAt };
  return { label: "First CI run", at: pr.firstRunAt };
}

/** What the pull requests can be sorted by: `date` is when it merged, or opened if it hasn't. */
export const PULL_REQUEST_SORTS = [
  "minutes",
  "number",
  "date",
  "rerunMinutes",
  "commits",
  "cost",
] as const;
export type PullRequestSortBy = (typeof PULL_REQUEST_SORTS)[number];

/** A sort as `sort=`: the column, with `-asc` when ascending. The default is the most minutes first. */
export interface PullRequestSort {
  id: PullRequestSortBy;
  desc: boolean;
}
export const DEFAULT_PULL_REQUEST_SORT: PullRequestSort = { id: "minutes", desc: true };

export const pullRequestSortParam = ({ id, desc }: PullRequestSort) => (desc ? id : `${id}-asc`);

export const isPullRequestSortBy = (id: string): id is PullRequestSortBy =>
  (PULL_REQUEST_SORTS as readonly string[]).includes(id);

/** The sort a `sort=` names, or the default when it names none. */
export function parsePullRequestSort(value: unknown): PullRequestSort {
  if (typeof value !== "string") return DEFAULT_PULL_REQUEST_SORT;
  const id = value.replace(/-asc$/, "");
  return isPullRequestSortBy(id) ? { id, desc: id === value } : DEFAULT_PULL_REQUEST_SORT;
}

/** Pull requests a page lists unless asked for more, and the most one lists. */
export const PULL_REQUEST_PAGE = 50;
export const PULL_REQUEST_MAX_PAGE = 500;

// What the report works out from every pull request it found, shared with the dashboard's sample
// data so both sort and sum them the same way.

const SORT_VALUE: Record<PullRequestSortBy, (pr: PullRequestMinutes) => number> = {
  minutes: (pr) => pr.minutes,
  number: (pr) => pr.number,
  date: (pr) => pullRequestDate(pr).at,
  rerunMinutes: (pr) => pr.rerunMinutes,
  commits: (pr) => pr.commits,
  cost: (pr) => pr.cost,
};

/** The pull requests in the order asked for, the newest number first among ties. */
export function sortPullRequests(
  pullRequests: PullRequestMinutes[],
  { id, desc }: PullRequestSort,
) {
  const value = SORT_VALUE[id];
  const sign = desc ? -1 : 1;
  return pullRequests.toSorted((a, b) => sign * (value(a) - value(b)) || b.number - a.number);
}

const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

/** The median and p90 of some values, their mean and their sum. Zeros when there are none. */
export function spreadOf(values: number[]): Spread {
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

/** What the view's tiles and spread chart show, for every pull request asked for. */
export function summarizePullRequests(
  pullRequests: PullRequestMinutes[],
  outside: PullRequestReport["outside"],
): PullRequestReport["summary"] {
  const minutes = spreadOf(pullRequests.map((pr) => pr.minutes));
  const allMinutes = minutes.total + total(outside.map((row) => row.minutes));
  return {
    count: pullRequests.length,
    minutes,
    cost: spreadOf(pullRequests.map((pr) => pr.cost)),
    prShare: allMinutes ? minutes.total / allMinutes : 0,
    rerunShare: minutes.total
      ? total(pullRequests.map((pr) => pr.rerunMinutes)) / minutes.total
      : 0,
    buckets: minuteBuckets(pullRequests.map((pr) => pr.minutes)),
  };
}

/** The summary of every pull request, and the page of them a query asks for, in its order. */
export function pullRequestPage(
  pullRequests: PullRequestMinutes[],
  outside: PullRequestReport["outside"],
  { sort, offset, limit }: { sort: PullRequestSort; offset: number; limit: number },
): Omit<PullRequestReport, "repositories"> {
  return {
    summary: summarizePullRequests(pullRequests, outside),
    pullRequests: sortPullRequests(pullRequests, sort).slice(offset, offset + limit),
    outside,
  };
}

// Round minute edges for the pull request bars, never hours.
const LADDER = [1, 2, 5, 10, 20, 30, 60, 120, 240, 480, 960, 1920];
// The most edges the bars split at, so they stay readable on a phone.
const MAX_EDGES = 7;

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
