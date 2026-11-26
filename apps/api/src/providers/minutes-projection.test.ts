import { describe, expect, test } from "vitest";
import { type DayUsage, projectMinutes } from "./minutes-projection.ts";

const cycleStart = new Date("2026-11-01T00:00:00Z");

// Every day of November up to (not including) `until`, weekdays at `weekday` and weekends at
// `weekend` minutes.
function november(until: number, weekday: number, weekend = weekday): DayUsage[] {
  return Array.from({ length: until - 1 }, (_, i) => {
    const day = `2026-11-${String(i + 1).padStart(2, "0")}`;
    const weekdayOf = new Date(`${day}T00:00:00Z`).getUTCDay();
    return { day, usedMinutes: weekdayOf === 0 || weekdayOf === 6 ? weekend : weekday };
  });
}
const total = (days: DayUsage[]) => days.reduce((sum, d) => sum + d.usedMinutes, 0);

describe("projectMinutes", () => {
  test("says when the minutes run out at a steady pace", () => {
    // 100 a day for 15 days, 1,500 of 2,000 used at midnight on the 16th: 5 more days.
    const days = november(16, 100);
    const projection = projectMinutes({
      days,
      usedMinutes: total(days),
      quotaMinutes: 2000,
      cycleStart,
      now: new Date("2026-11-16T00:00:00Z"),
    });
    expect(projection).toEqual({
      outlook: "runs_out",
      minutesPerDay: 100,
      projectedMinutes: 3000,
      runsOutAt: "2026-11-21T00:00:00.000Z",
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  test("weekends at their own rate push the run-out day out", () => {
    // Weekdays 150, weekends 0. Nov 16 is a Monday: 1,500 used, 500 left = Mon to Wed, then
    // a third of Thursday.
    const days = november(16, 150, 0);
    const projection = projectMinutes({
      days,
      usedMinutes: total(days),
      quotaMinutes: 2000,
      cycleStart,
      now: new Date("2026-11-16T00:00:00Z"),
    });
    expect(projection?.outlook).toBe("runs_out");
    expect(projection?.runsOutAt).toBe("2026-11-19T08:00:00.000Z");
    expect(projection?.minutesPerDay).toBeCloseTo(107.1, 1);
  });

  test("uses the last two weeks, so a quieter stretch shows up quickly", () => {
    // Busy the first week, then 20 a day: the early burst doesn't set the pace.
    const days = november(23, 20).map((d) =>
      d.day <= "2026-11-07" ? { ...d, usedMinutes: 200 } : d,
    );
    const projection = projectMinutes({
      days,
      usedMinutes: total(days),
      quotaMinutes: 3000,
      cycleStart,
      now: new Date("2026-11-23T00:00:00Z"),
    });
    expect(projection).toMatchObject({ outlook: "surplus", minutesPerDay: 20, runsOutAt: null });
    expect(projection?.projectedMinutes).toBe(total(days) + 8 * 20);
  });

  test("on track when most of the minutes get used and they last", () => {
    const days = november(16, 85);
    const projection = projectMinutes({
      days,
      usedMinutes: total(days),
      quotaMinutes: 3000,
      cycleStart,
      now: new Date("2026-11-16T00:00:00Z"),
    });
    expect(projection).toMatchObject({ outlook: "on_track", projectedMinutes: 2550 });
  });

  test("over once the minutes are used up", () => {
    const days = november(16, 200);
    expect(
      projectMinutes({
        days,
        usedMinutes: total(days),
        quotaMinutes: 2000,
        cycleStart,
        now: new Date("2026-11-16T00:00:00Z"),
      }),
    ).toMatchObject({ outlook: "over", runsOutAt: null, projectedMinutes: 6000 });
  });

  test("without daily figures, the cycle's average so far stands in", () => {
    const projection = projectMinutes({
      days: [],
      usedMinutes: 1000,
      quotaMinutes: 3000,
      cycleStart,
      now: new Date("2026-11-11T00:00:00Z"),
    });
    expect(projection).toMatchObject({ outlook: "on_track", minutesPerDay: 100 });
    // 1,000 + 20 days x 100 lands right on the quota at the reset: they last.
    expect(projection?.projectedMinutes).toBe(3000);
  });

  test("nothing without a quota or before a full day has passed", () => {
    const base = { days: [], usedMinutes: 10, cycleStart };
    expect(
      projectMinutes({ ...base, quotaMinutes: null, now: new Date("2026-11-16T00:00:00Z") }),
    ).toBeNull();
    expect(
      projectMinutes({ ...base, quotaMinutes: 2000, now: new Date("2026-11-01T18:00:00Z") }),
    ).toBeNull();
  });
});
