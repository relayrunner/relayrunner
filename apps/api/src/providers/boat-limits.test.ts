import { describe, expect, test } from "vitest";
import { ranOutOfStarts, StartBudget } from "./boat-limits.ts";
import type { StartsLeft } from "../provider-billing/boat.ts";

const starts = (minute: number, hour: number, day: number): StartsLeft => ({
  minute: { remaining: minute, limit: 12 },
  hour: { remaining: hour, limit: 60 },
  day: { remaining: day, limit: 200 },
});

describe("ranOutOfStarts", () => {
  test("names the hour or day window with no starts left", () => {
    expect(ranOutOfStarts(starts(5, 10, 100))).toBeNull();
    expect(ranOutOfStarts(starts(5, 0, 100))).toEqual({ window: "hour", limit: 60 });
    expect(ranOutOfStarts(starts(5, 0, 0))).toEqual({ window: "hour", limit: 60 });
    expect(ranOutOfStarts(starts(5, 10, 0))).toEqual({ window: "day", limit: 200 });
  });

  test("a full minute window doesn't pass the job on, since Boat waits for it", () => {
    expect(ranOutOfStarts(starts(0, 10, 100))).toBeNull();
  });

  test("counts the jobs sent since the reading, and never blocks without one", () => {
    expect(ranOutOfStarts(starts(5, 2, 100), 1)).toBeNull();
    expect(ranOutOfStarts(starts(5, 2, 100), 2)).toEqual({ window: "hour", limit: 60 });
    expect(ranOutOfStarts(null, 50)).toBeNull();
    expect(ranOutOfStarts({ minute: null, hour: null, day: null }, 50)).toBeNull();
  });
});

describe("StartBudget", () => {
  test("reuses a reading, spends it as jobs go to Boat, and reads again once it's old", async () => {
    const budget = new StartBudget(10_000);
    let reads = 0;
    const read = async () => {
      reads++;
      return starts(5, 2, 100);
    };
    expect(await budget.check(read, 0)).toBeNull();
    budget.took();
    expect(await budget.check(read, 1_000)).toBeNull();
    budget.took();
    expect(await budget.check(read, 2_000)).toEqual({ window: "hour", limit: 60 });
    expect(reads).toBe(1);
    // A fresh reading starts the count again.
    expect(await budget.check(read, 10_000)).toBeNull();
    expect(reads).toBe(2);
  });

  test("a failed read takes the job", async () => {
    const budget = new StartBudget();
    expect(await budget.check(async () => Promise.reject(new Error("down")), 0)).toBeNull();
  });
});
