import { describe, expect, test } from "vitest";
import { chartBuckets, hasTrend, parseWindow, withPrior } from "./report-window.ts";
import { DAY_MS } from "../time.ts";

const now = Date.parse("2026-11-20T12:00:00Z");
const limits = { maxDays: 31, defaultDays: 14 };

describe("parseWindow", () => {
  test("reads the last ?days=N, or the default, against the days before", () => {
    expect(parseWindow({ days: "7" }, limits, now)).toEqual({
      from: now - 7 * DAY_MS,
      to: now,
      prior: { from: now - 14 * DAY_MS, to: now - 7 * DAY_MS },
    });
    expect(parseWindow({}, limits, now)).toMatchObject({ from: now - 14 * DAY_MS, to: now });
    expect(parseWindow({ days: "32" }, limits, now)).toBeNull();
  });

  test("reads a calendar window, ending no later than now", () => {
    const from = Date.parse("2026-11-01T05:00:00Z");
    expect(
      parseWindow({ from: String(from), to: String(now + DAY_MS) }, limits, now),
    ).toMatchObject({ from, to: now });
    const october = {
      from: String(Date.parse("2026-10-01")),
      to: String(Date.parse("2026-11-01")),
    };
    expect(parseWindow(october, { maxDays: 90, defaultDays: 30 }, now)).toMatchObject({
      from: Date.parse("2026-10-01"),
      to: Date.parse("2026-11-01"),
    });
  });

  test("compares this month with the same days of last month", () => {
    const query = {
      from: String(Date.parse("2026-11-01")),
      to: String(now),
      priorFrom: String(Date.parse("2026-10-01")),
    };
    expect(parseWindow(query, limits, now)?.prior).toEqual({
      from: Date.parse("2026-10-01"),
      to: Date.parse("2026-10-20T12:00:00Z"),
    });
  });

  test("turns down windows out of order, half given, or past the limit", () => {
    expect(parseWindow({ from: String(now), to: String(now - DAY_MS) }, limits, now)).toBeNull();
    expect(parseWindow({ from: String(now - DAY_MS) }, limits, now)).toBeNull();
    const october = {
      from: String(Date.parse("2026-10-01")),
      to: String(Date.parse("2026-11-01")),
    };
    expect(parseWindow(october, limits, now)).toBeNull();
    const late = { from: String(now - DAY_MS), to: String(now), priorFrom: String(now) };
    expect(parseWindow(late, limits, now)).toBeNull();
  });
});

describe("withPrior", () => {
  test("stops a longer month's prior window where the window starts", () => {
    // October has 31 days, September 30.
    const october = { from: Date.parse("2026-10-01"), to: Date.parse("2026-11-01") };
    expect(withPrior(october, Date.parse("2026-09-01")).prior).toEqual({
      from: Date.parse("2026-09-01"),
      to: Date.parse("2026-10-01"),
    });
  });

  test("has a trend only while single jobs still cover the prior window", () => {
    const last = (days: number) => withPrior({ from: now - days * DAY_MS, to: now });
    expect(hasTrend(last(30), now)).toBe(true);
    expect(hasTrend(last(31), now)).toBe(true);
    expect(hasTrend(last(32), now)).toBe(false);
  });
});

describe("chartBuckets", () => {
  const from = Date.parse("2026-11-01T00:00:00Z");
  const window = { from, to: from + 20 * DAY_MS };

  test("bars a day at a time up to a month, from the reader's midnight", () => {
    expect(chartBuckets(window, String(from - 3_600_000))).toEqual({
      bucketMs: DAY_MS,
      origin: from - 3_600_000,
    });
  });

  test("bars an hour at a time when asked over two days or less, else a day", () => {
    const day = { from, to: from + DAY_MS };
    expect(chartBuckets(day, String(from - 1_800_000), "hour")).toEqual({
      bucketMs: 3_600_000,
      origin: from - 1_800_000,
    });
    expect(chartBuckets(window, String(from), "hour")).toEqual({ bucketMs: DAY_MS, origin: from });
  });

  test("bars a week at a time when asked, from the start of the reader's week", () => {
    const monday = from - 5 * DAY_MS;
    expect(chartBuckets(window, String(monday), "week")).toEqual({
      bucketMs: 7 * DAY_MS,
      origin: monday,
    });
  });

  test("ignores an origin more than a bar before the window", () => {
    expect(chartBuckets(window, String(from - 2 * DAY_MS)).origin).toBe(from);
  });
});
