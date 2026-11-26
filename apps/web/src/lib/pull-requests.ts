import { api } from "./api";
import { rangeQuery, type TimeRange } from "./time-range";

/** One pull request's CI in GET /api/usage/pull-requests. Minutes are run time; money is USD. */
export type PullRequestMinutes = {
  repository: string;
  number: number;
  title: string | null;
  minutes: number;
  /** The part of `minutes` from re-runs (attempt 2 and up). */
  rerunMinutes: number;
  billedMinutes: number;
  cost: number;
  jobs: number;
  runs: number;
  commits: number;
  /** Epoch ms. */
  lastAt: number;
};

/** Jobs no pull request was found for in one repo. */
export type OutsidePullRequests = {
  repository: string;
  minutes: number;
  billedMinutes: number;
  cost: number;
  jobs: number;
};

export type PullRequestReport = {
  /** Where the report starts, epoch ms: later than the range's start past what the API keeps. */
  from: number;
  to: number;
  /** The most minutes first. */
  pullRequests: PullRequestMinutes[];
  outside: OutsidePullRequests[];
};

export function getPullRequests(range: TimeRange) {
  return api<PullRequestReport>(`/usage/pull-requests?${rangeQuery(range)}`);
}

/** The median and p90 of some values, and their mean. Zeros when there are none. */
export type Spread = { median: number; p90: number; average: number };

/** Interpolated between the closest values, like the API's percentiles. */
export function spreadOf(values: number[]): Spread {
  if (!values.length) return { median: 0, p90: 0, average: 0 };
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => {
    const index = (sorted.length - 1) * q;
    const lo = Math.floor(index);
    const hi = Math.ceil(index);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
  };
  return {
    median: at(0.5),
    p90: at(0.9),
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

/** What the view's tiles show, for the pull requests and other jobs a repo filter keeps. */
export function summarize(pullRequests: PullRequestMinutes[], outside: OutsidePullRequests[]) {
  const sum = (rows: { minutes: number }[]) => rows.reduce((total, row) => total + row.minutes, 0);
  const prMinutes = sum(pullRequests);
  const allMinutes = prMinutes + sum(outside);
  return {
    count: pullRequests.length,
    minutes: spreadOf(pullRequests.map((pr) => pr.minutes)),
    cost: spreadOf(pullRequests.map((pr) => pr.cost)),
    totalCost: pullRequests.reduce((total, pr) => total + pr.cost, 0),
    /** Of all the jobs' minutes, the share that ran for pull requests. */
    prShare: allMinutes ? prMinutes / allMinutes : 0,
    /** Of the pull requests' minutes, the share from re-runs. */
    rerunShare: prMinutes
      ? pullRequests.reduce((total, pr) => total + pr.rerunMinutes, 0) / prMinutes
      : 0,
  };
}
