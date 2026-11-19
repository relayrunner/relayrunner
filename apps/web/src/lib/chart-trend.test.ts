import { describe, expect, it } from "vitest";
import { bucketIndex, bucketMsFor, chartStart, groupsByCount, spreads } from "./chart-trend.ts";

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

  it("starts at the first point, not the start of the range", () => {
    expect(chartStart(now, 7, now - 2 * DAY_MS)).toBe(now - 2 * DAY_MS);
  });

  it("shows at least six hours", () => {
    expect(chartStart(now, 7, now - HOUR_MS)).toBe(now - 6 * HOUR_MS);
  });

  it("never starts before the range", () => {
    expect(chartStart(now, 1, now - 3 * DAY_MS)).toBe(now - DAY_MS);
    expect(chartStart(now, 7, undefined)).toBe(now - 7 * DAY_MS);
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

describe("spreads", () => {
  it("finds each bucket's median, 10th and 90th percentile, leaving empty ones out", () => {
    const values = [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({ at: 10, value })),
      { at: 250, value: 40 },
      { at: 260, value: 20 },
    ];
    expect(spreads(values, 0, 300, 100)).toEqual([
      { at: 0, count: 10, p10: 2, median: 6, p90: 9 },
      { at: 200, count: 2, p10: 22, median: 30, p90: 38 },
    ]);
  });

  it("keeps points past either end in the first or last bucket", () => {
    const result = spreads(
      [
        { at: -5, value: 1 },
        { at: 305, value: 2 },
      ],
      0,
      300,
      100,
    );
    expect(result.map((spread) => spread.at)).toEqual([0, 200]);
  });
});
