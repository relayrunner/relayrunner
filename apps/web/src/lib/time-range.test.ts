import { describe, expect, test } from "vitest";
import {
  customRange,
  dayPreset,
  presetDays,
  rangeName,
  rangePhrase,
  reportQuery,
  resolveRange,
  spanCode,
  timeRangeParam,
  trendPhrase,
} from "./time-range.ts";

// Saturday, Nov 14 2026, 7 PM local.
const now = new Date(2026, 10, 14, 19).getTime();
const HOUR = 3_600_000;

describe("resolveRange", () => {
  test("reads rolling presets back from now", () => {
    expect(resolveRange("24h", now)).toEqual({ from: now - 24 * HOUR, to: now });
    expect(resolveRange("7d", now).from).toBe(now - 7 * 24 * HOUR);
  });

  test("reads calendar presets from local midnight and Monday", () => {
    expect(resolveRange("today", now)).toEqual({ from: new Date(2026, 10, 14).getTime(), to: now });
    expect(resolveRange("yesterday", now)).toEqual({
      from: new Date(2026, 10, 13).getTime(),
      to: new Date(2026, 10, 14).getTime(),
    });
    expect(resolveRange("week", now).from).toBe(new Date(2026, 10, 9).getTime());
    expect(resolveRange("lastweek", now)).toEqual({
      from: new Date(2026, 10, 2).getTime(),
      to: new Date(2026, 10, 9).getTime(),
    });
  });

  test("reads months from local midnight on the first", () => {
    expect(resolveRange("month", now)).toEqual({ from: new Date(2026, 10, 1).getTime(), to: now });
    expect(resolveRange("lastmonth", now)).toEqual({
      from: new Date(2026, 9, 1).getTime(),
      to: new Date(2026, 10, 1).getTime(),
    });
    // January's last month is the year before's December.
    const january = new Date(2027, 0, 10).getTime();
    expect(resolveRange("lastmonth", january).from).toBe(new Date(2026, 11, 1).getTime());
  });

  test("takes in both days of a custom range, up to now", () => {
    expect(resolveRange("2026-11-01..2026-11-03", now)).toEqual({
      from: new Date(2026, 10, 1).getTime(),
      to: new Date(2026, 10, 4).getTime(),
    });
    expect(resolveRange("2026-11-10..2026-11-14", now).to).toBe(now);
  });
});

test("spanCode says how long a range spans", () => {
  expect(spanCode("24h", now)).toBe("24h");
  expect(spanCode("today", now)).toBe("19h");
  expect(spanCode("week", now)).toBe("6d");
  expect(spanCode("month", now)).toBe("14d");
  expect(spanCode("lastmonth", now)).toBe("31d");
});

test("rangeName names presets and custom ranges", () => {
  expect(rangeName("14d")).toBe("Past 14 days");
  expect(rangeName("week")).toBe("This week");
  expect(rangeName(customRange("2026-11-07", "2026-11-01"))).toMatch(/Nov 1 – Nov 7/);
});

test("rangePhrase ends a sentence", () => {
  expect(rangePhrase("24h")).toBe("the past 24 hours");
  expect(rangePhrase("today")).toBe("today");
  expect(rangePhrase("month")).toBe("this month");
  expect(rangePhrase("lastweek")).toBe("last week");
});

test("dayPreset and presetDays map the older day counts", () => {
  expect([1, 7, 30].map(dayPreset)).toEqual(["24h", "7d", "30d"]);
  expect(presetDays("24h")).toBe(1);
  expect(presetDays("90d")).toBe(90);
});

describe("reportQuery", () => {
  const local = (month: number, day: number) => new Date(2026, month, day).getTime();

  test("sends a rolling range as the last N days", () => {
    expect(reportQuery("7d", {}, now)).toBe("days=7");
    expect(reportQuery("24h", {}, now)).toBe("days=1");
  });

  test("compares a calendar range with the same stretch one period back", () => {
    expect(reportQuery("month", {}, now)).toBe(
      `from=${local(10, 1)}&to=${now}&priorFrom=${local(9, 1)}`,
    );
    expect(reportQuery("lastmonth", {}, now)).toBe(
      `from=${local(9, 1)}&to=${local(10, 1)}&priorFrom=${local(8, 1)}`,
    );
    expect(reportQuery("week", {}, now)).toBe(
      `from=${local(10, 9)}&to=${now}&priorFrom=${local(10, 2)}`,
    );
    expect(reportQuery("lastweek", {}, now)).toContain(`&priorFrom=${local(9, 26)}`);
  });

  test("names what the trend compares with", () => {
    expect(trendPhrase("7d")).toBe("the 7 days before");
    expect(trendPhrase("24h")).toBe("the day before");
    expect(trendPhrase("month")).toBe("the same days last month");
    expect(trendPhrase("lastweek")).toBe("the week before");
  });
});

describe("timeRangeParam", () => {
  const options = { presets: ["24h", "14d", "today"] as const, customDays: 90 };

  test("keeps a preset the page offers, other than its default", () => {
    expect(timeRangeParam("24h", options, "14d", now)).toBe("24h");
    expect(timeRangeParam("14d", options, "14d", now)).toBeUndefined();
    expect(timeRangeParam("3h", options, "14d", now)).toBeUndefined();
  });

  test("keeps a custom range within reach, and only where the page takes one", () => {
    expect(timeRangeParam("2026-11-01..2026-11-07", options, "14d", now)).toBe(
      "2026-11-01..2026-11-07",
    );
    expect(timeRangeParam("2026-11-07..2026-11-01", options, "14d", now)).toBeUndefined();
    expect(timeRangeParam("2026-01-01..2026-01-07", options, "14d", now)).toBeUndefined();
    expect(timeRangeParam("2026-11-01..2026-12-01", options, "14d", now)).toBeUndefined();
    expect(
      timeRangeParam("2026-11-01..2026-11-07", { presets: ["24h"] }, "14d", now),
    ).toBeUndefined();
  });
});
