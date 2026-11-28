import { describe, expect, test } from "vitest";
import {
  minuteBuckets,
  parsePullRequestSort,
  pullRequestDate,
  pullRequestSortParam,
  type PullRequestMinutes,
  sortPullRequests,
  spreadOf,
  summarizePullRequests,
} from "./pull-requests.ts";

const pr = (minutes: number, rerunMinutes = 0): PullRequestMinutes => ({
  repository: "acme/app",
  number: minutes,
  title: null,
  minutes,
  rerunMinutes,
  cost: minutes * 0.006,
  commits: 1,
  openedAt: null,
  mergedAt: null,
  closedAt: null,
  firstRunAt: 100,
});

describe("pull request summary", () => {
  test("interpolates the median and p90", () => {
    expect(spreadOf([])).toEqual({ median: 0, p90: 0, average: 0, total: 0 });
    expect(spreadOf([40, 10, 20, 30])).toEqual({ median: 25, p90: 37, average: 25, total: 100 });
  });

  test("shares pull request and re-run minutes", () => {
    const summary = summarizePullRequests(
      [pr(30, 6), pr(10)],
      [{ repository: "acme/app", minutes: 60 }],
    );
    expect(summary).toMatchObject({ count: 2, prShare: 0.4, rerunShare: 0.15 });
    expect(summary.minutes.median).toBe(20);
  });

  test("sorts by date, newest number first among ties", () => {
    const merged = { ...pr(1), number: 7, mergedAt: 300, closedAt: 300 };
    const opened = { ...pr(2), number: 8, openedAt: 200 };
    const firstRun = { ...pr(3), number: 9 };
    const sorted = sortPullRequests([firstRun, opened, merged], { id: "date", desc: true });
    expect(sorted.map((row) => row.number)).toEqual([7, 8, 9]);
    const tie = sortPullRequests([pr(5), { ...pr(5), number: 6 }], { id: "minutes", desc: true });
    expect(tie.map((row) => row.number)).toEqual([6, 5]);
  });
});

describe("pull request minute bars", () => {
  test("splits at round edges across the middle of the spread", () => {
    const values = [3, 4, 8, 12, 14, 18, 25, 40, 70, 400];
    const buckets = minuteBuckets(values);
    expect(buckets.map((b) => [b.from, b.to])).toEqual([
      [0, 10],
      [10, 20],
      [20, 30],
      [30, 60],
      [60, 120],
      [120, 240],
      [240, 480],
      [480, null],
    ]);
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(values.length);
    expect(buckets.slice(3, 5).map((b) => b.count)).toEqual([1, 1]);
    expect(minuteBuckets([])).toEqual([]);
  });

  test("keeps the bars few when the spread is wide", () => {
    const buckets = minuteBuckets([1, 5, 30, 200, 900, 2000]);
    expect(buckets).toHaveLength(8);
    expect(buckets.map((b) => b.from).slice(0, 2)).toEqual([0, 30]);
    expect(buckets.at(-1)).toMatchObject({ from: 1920, to: null, count: 1 });
  });
});

describe("pull request date", () => {
  test("is when it merged, else opened, else its first run", () => {
    expect(pullRequestDate(pr(1))).toEqual({ label: "First CI run", at: 100 });
    expect(pullRequestDate({ ...pr(1), openedAt: 50 }).at).toBe(50);
    expect(pullRequestDate({ ...pr(1), openedAt: 50, mergedAt: 300, closedAt: 300 }).at).toBe(300);
  });
});

describe("pull request sort param", () => {
  test("names the column, with -asc when ascending", () => {
    expect(pullRequestSortParam({ id: "date", desc: true })).toBe("date");
    expect(pullRequestSortParam({ id: "number", desc: false })).toBe("number-asc");
  });

  test("reads only what it can sort by, else the default", () => {
    expect(parsePullRequestSort("number-asc")).toEqual({ id: "number", desc: false });
    expect(parsePullRequestSort("date")).toEqual({ id: "date", desc: true });
    expect(parsePullRequestSort("title")).toEqual({ id: "minutes", desc: true });
    expect(parsePullRequestSort(undefined)).toEqual({ id: "minutes", desc: true });
  });
});
