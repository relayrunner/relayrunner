import { describe, expect, test } from "vitest";
import { parseWindow } from "./report-window.ts";
import { DAY_MS } from "./time.ts";

const now = Date.parse("2026-11-20T12:00:00Z");
const limits = { maxDays: 31, defaultDays: 14 };

describe("parseWindow", () => {
  test("reads the last ?days=N, or the default", () => {
    expect(parseWindow({ days: "7" }, limits, now)).toEqual({ from: now - 7 * DAY_MS, to: now });
    expect(parseWindow({}, limits, now)).toEqual({ from: now - 14 * DAY_MS, to: now });
    expect(parseWindow({ days: "32" }, limits, now)).toBeNull();
  });

  test("reads a calendar window, ending no later than now", () => {
    const from = Date.parse("2026-11-01T05:00:00Z");
    expect(parseWindow({ from: String(from), to: String(now + DAY_MS) }, limits, now)).toEqual({
      from,
      to: now,
    });
    const october = {
      from: String(Date.parse("2026-10-01")),
      to: String(Date.parse("2026-11-01")),
    };
    expect(parseWindow(october, { maxDays: 90, defaultDays: 30 }, now)).toEqual({
      from: Date.parse("2026-10-01"),
      to: Date.parse("2026-11-01"),
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
  });
});
