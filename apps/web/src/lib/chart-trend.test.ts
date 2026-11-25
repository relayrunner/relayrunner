import { describe, expect, it } from "vitest";
import {
  bucketIndex,
  bucketMsFor,
  chartStart,
  groupsByCount,
  periodStarts,
  rollingSpreads,
  rollingWindow,
} from "./chart-trend.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

describe("bucketMsFor", () => {
  it("picks the narrowest bucket that keeps about 48 of them", () => {
    expect(bucketMsFor(6 * HOUR_MS)).toBe(HOUR_MS);
    expect(bucketMsFor(2 * DAY_MS)).toBe(HOUR_MS);
    expect(bucketMsFor(3 * DAY_MS)).toBe(2 * HOUR_MS);
    expect(bucketMsFor(7 * DAY_MS)).toBe(4 * HOUR_MS);
    expect(bucketMsFor(30 * DAY_MS)).toBe(DAY_MS);
    expect(bucketMsFor(90 * DAY_MS)).toBe(DAY_MS);
  });
});

describe("chartStart", () => {
  const now = 100 * DAY_MS;
  const last = (days: number) => ({ from: now - days * DAY_MS, to: now });

  it("starts at the first point, not the start of the range", () => {
    expect(chartStart(last(7), now - 2 * DAY_MS)).toBe(now - 2 * DAY_MS);
  });

  it("shows at least six hours", () => {
    expect(chartStart(last(7), now - HOUR_MS)).toBe(now - 6 * HOUR_MS);
  });

  it("ends with a range that ended before now, such as last week", () => {
    const lastWeek = { from: now - 14 * DAY_MS, to: now - 7 * DAY_MS };
    expect(chartStart(lastWeek, now - 7 * DAY_MS - HOUR_MS)).toBe(now - 7 * DAY_MS - 6 * HOUR_MS);
  });

  it("never starts before the range", () => {
    expect(chartStart(last(1), now - 3 * DAY_MS)).toBe(now - DAY_MS);
    expect(chartStart(last(7), undefined)).toBe(now - 7 * DAY_MS);
  });
});

describe("groupsByCount", () => {
  it("puts the busiest first, then sorts by name", () => {
    expect(groupsByCount(["Release", "CI", "CI", "Docs", "Release", "CI"])).toEqual([
      "CI",
      "Release",
      "Docs",
    ]);
  });
});

describe("bucketIndex", () => {
  it("puts times past either end in the first or last bucket", () => {
    expect(bucketIndex(150, 0, 300, 100)).toBe(1);
    expect(bucketIndex(-5, 0, 300, 100)).toBe(0);
    expect(bucketIndex(305, 0, 300, 100)).toBe(2);
  });
});

describe("rollingWindow", () => {
  it("takes about a tenth of the runs, odd, from 5 to 21", () => {
    expect(rollingWindow(3)).toBe(3);
    expect(rollingWindow(40)).toBe(5);
    expect(rollingWindow(88)).toBe(9);
    expect(rollingWindow(120)).toBe(13);
    expect(rollingWindow(1000)).toBe(21);
  });
});

describe("rollingSpreads", () => {
  it("finds the median and middle 80% of each value's neighbours", () => {
    const result = rollingSpreads([10, 20, 30, 40, 50], 3);
    expect(result.map((spread) => spread.median)).toEqual([20, 20, 30, 40, 40]);
    expect(result[2]).toEqual({ p10: 22, median: 30, p90: 38 });
  });

  it("uses every value when there are fewer than the window", () => {
    expect(rollingSpreads([5, 1], 9).map((spread) => spread.median)).toEqual([3, 3]);
  });
});

describe("periodStarts", () => {
  it("marks the first time in each period", () => {
    const day = (at: number) => Math.floor(at / 100);
    expect(periodStarts([10, 20, 150, 160, 420], day)).toEqual([0, 2, 4]);
    expect(periodStarts([], day)).toEqual([]);
  });
});
