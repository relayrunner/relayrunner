import {
  DEFAULT_PULL_REQUEST_SORT,
  type MinuteBucket,
  parsePullRequestSort,
  pullRequestSortParam,
  type PullRequestMinutes,
  type PullRequestReport,
  type PullRequestSort,
} from "@relayrunner/api-types";
import { api } from "./api";
import { unlessDefault } from "./search-params";
import { type RangeOptions, rangeQuery, type TimeRange } from "./time-range";

export type { PullRequestMinutes, PullRequestReport };

/** The view reads jobs' own rows, which the API keeps 62 days, so it has no 90-day range. */
export const PULL_REQUEST_RANGES: RangeOptions = {
  presets: ["7d", "14d", "30d", "week", "lastweek", "month", "lastmonth"],
};

/** A sort as the table's `?sort=`: nothing for the default. */
export const sortSearchParam = (sort: PullRequestSort) =>
  unlessDefault(pullRequestSortParam(sort), pullRequestSortParam(DEFAULT_PULL_REQUEST_SORT));

/** The table's sort from its `?sort=`, the default when it names nothing it can sort by. */
export const sortFromSearch = (value: unknown) => parsePullRequestSort(value);

/** One page of the pull requests: one repo's ("all" for every one), in `sort` order, the first `limit`. */
export function getPullRequests(
  range: TimeRange,
  { repository, sort, limit }: { repository: string; sort: PullRequestSort; limit: number },
) {
  const query = rangeQuery(range, {
    repo: unlessDefault(repository, "all"),
    sort: sortSearchParam(sort),
    limit: String(limit),
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
