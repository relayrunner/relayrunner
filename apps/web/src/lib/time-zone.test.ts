import { afterEach, describe, expect, test } from "vitest";
import {
  dateText,
  dayHeading,
  parseDateText,
  setTimeZone,
  startOfDay,
  startOfHours,
  startOfWeek,
  zoneOffset,
} from "./time-zone.ts";

const HOUR = 3_600_000;

afterEach(() => setTimeZone(null));

describe("a chosen zone", () => {
  test("cuts days at its own midnight", () => {
    setTimeZone("Asia/Tokyo"); // UTC+9, no daylight saving.
    // 20:00 UTC on Nov 14 is 05:00 on Nov 15 in Tokyo.
    const at = Date.UTC(2026, 10, 14, 20);
    expect(dateText(at)).toBe("2026-11-15");
    expect(startOfDay(at)).toBe(Date.UTC(2026, 10, 14, 15));
    expect(startOfDay(at, -1)).toBe(Date.UTC(2026, 10, 13, 15));
    expect(zoneOffset(at)).toBe(540);
    expect(parseDateText("2026-11-15")).toBe(Date.UTC(2026, 10, 14, 15));
    expect(parseDateText("2026-02-30")).toBeNaN();
  });

  test("starts weeks on Monday and hours on their block", () => {
    setTimeZone("UTC");
    const sunday = Date.UTC(2026, 10, 15, 13, 20);
    expect(startOfWeek(sunday)).toBe(Date.UTC(2026, 10, 9));
    expect(startOfHours(sunday, 6)).toBe(Date.UTC(2026, 10, 15, 12));
  });

  test("keeps days whole across a daylight saving change", () => {
    setTimeZone("America/New_York"); // Clocks went back on Nov 1, 2026.
    const after = Date.UTC(2026, 10, 1, 18);
    expect(startOfDay(after)).toBe(Date.UTC(2026, 10, 1, 4));
    expect(startOfDay(after, 1)).toBe(Date.UTC(2026, 10, 2, 5));
  });
});

describe("dayHeading", () => {
  test("names today and yesterday, and dates the rest", () => {
    setTimeZone("UTC");
    const now = Date.UTC(2026, 10, 16, 9);
    expect(dayHeading(now - HOUR, now)).toBe("Today");
    expect(dayHeading(Date.UTC(2026, 10, 15, 23), now)).toBe("Yesterday");
    expect(dayHeading(Date.UTC(2026, 10, 14, 12), now)).toMatch(/Nov 14|14 Nov/);
    expect(dayHeading(Date.UTC(2025, 10, 14, 12), now)).toMatch(/2025/);
  });
});
