import { describe, expect, test } from "vitest";
import {
  bucketPosition,
  minuteBuckets,
  type PullRequestMinutes,
  spreadOf,
  summarize,
} from "./pull-requests";

const pr = (minutes: number, rerunMinutes = 0): PullRequestMinutes => ({
  repository: "acme/app",
  number: minutes,
  title: null,
  minutes,
  rerunMinutes,
  cost: minutes * 0.006,
  commits: 1,
});

describe("pull request summary", () => {
  test("interpolates the median and p90", () => {
    expect(spreadOf([])).toEqual({ median: 0, p90: 0, average: 0, total: 0 });
    expect(spreadOf([40, 10, 20, 30])).toEqual({ median: 25, p90: 37, average: 25, total: 100 });
  });

  test("shares pull request and re-run minutes", () => {
    const summary = summarize([pr(30, 6), pr(10)], [{ repository: "acme/app", minutes: 60 }]);
    expect(summary).toMatchObject({ count: 2, prShare: 0.4, rerunShare: 0.15 });
    expect(summary.minutes.median).toBe(20);
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
  });

  test("keeps the bars few when the spread is wide", () => {
    const buckets = minuteBuckets([1, 5, 30, 200, 900, 2000]);
    expect(buckets).toHaveLength(8);
    expect(buckets.map((b) => b.from).slice(0, 2)).toEqual([0, 30]);
    expect(buckets.at(-1)).toMatchObject({ from: 1920, to: null, count: 1 });
  });

  test("places a value across the bars", () => {
    const buckets = minuteBuckets([3, 4, 8, 12, 14, 18, 25, 40, 70, 400]);
    expect(bucketPosition(buckets, 15)).toBe(1.5);
    expect(bucketPosition(buckets, 500)).toBe(7.5);
    expect(minuteBuckets([])).toEqual([]);
  });
});
