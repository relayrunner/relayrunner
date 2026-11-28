import {
  DEFAULT_PULL_REQUEST_SORT,
  type MinuteBucket,
  pullRequestSortParam,
  type PullRequestMinutes,
  type PullRequestReport,
  type PullRequestSort,
} from "@relayrunner/api-types";
import { api } from "./api";
import { unlessDefault } from "./search-params";
import { type RangeOptions, rangeQuery, type TimeRange } from "./time-range";

/** The view reads jobs' own rows, which the API keeps 62 days, so it has no 90-day range. */
export const PULL_REQUEST_RANGES: RangeOptions = {
  presets: ["7d", "14d", "30d", "week", "lastweek", "month", "lastmonth"],
};

/** A sort as the table's `?sort=`: nothing for the default. */
export const sortSearchParam = (sort: PullRequestSort) =>
  unlessDefault(pullRequestSortParam(sort), pullRequestSortParam(DEFAULT_PULL_REQUEST_SORT));

/** One page of the pull requests: one repo's ("all" for every one), in `sort` order, from `offset`. */
export function getPullRequests(
  range: TimeRange,
  { repository, sort, offset }: { repository: string; sort: PullRequestSort; offset: number },
) {
  const query = rangeQuery(range, {
    repo: unlessDefault(repository, "all"),
    sort: sortSearchParam(sort),
    offset: offset ? String(offset) : undefined,
  });
  return api<PullRequestReport>(`/usage/pull-requests?${query}`);
}

/** Merged, closed without merging, or open (or not known: shown as open). */
export const stateOf = (pr: PullRequestMinutes) =>
  pr.mergedAt !== null ? "merged" : pr.closedAt !== null ? "closed" : "open";

/** Where `value` falls across the bars, in bars from the left edge (2.5 is mid third bar). */
export function bucketPosition(buckets: MinuteBucket[], value: number) {
  const i = buckets.findIndex((b) => b.to === null || value < b.to);
  if (i < 0) return buckets.length;
  const { from, to } = buckets[i]!;
  return i + (to === null ? 0.5 : (value - from) / (to - from));
}
