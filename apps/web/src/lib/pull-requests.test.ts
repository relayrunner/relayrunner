import { describe, expect, test } from "vitest";
import { type PullRequestMinutes, spreadOf, summarize } from "./pull-requests";

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
