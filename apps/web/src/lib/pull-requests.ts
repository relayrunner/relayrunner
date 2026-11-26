import { api } from "./api";
import { interpolate } from "./chart-trend";
import { rangeQuery, type TimeRange } from "./time-range";

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
};

export type PullRequestReport = {
  /** The most minutes first. */
  pullRequests: PullRequestMinutes[];
  /** Minutes of jobs no pull request was found for, per repo. */
  outside: { repository: string; minutes: number }[];
};

export function getPullRequests(range: TimeRange) {
  return api<PullRequestReport>(`/usage/pull-requests?${rangeQuery(range)}`);
}

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
