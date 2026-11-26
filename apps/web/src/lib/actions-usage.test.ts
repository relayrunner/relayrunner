import { describe, expect, test } from "vitest";
import { type AccountUsage, type MinutesProjection, paceText } from "./actions-usage";
import { setTimeZone } from "./time-zone";

setTimeZone("UTC");

const usage = (projection: Partial<MinutesProjection> | null, quota: number | null = 3000) =>
  ({
    installationId: 1,
    accountLogin: "your-org",
    accountType: "Organization",
    status: "ok",
    reason: null,
    plan: "team",
    quotaMinutes: quota,
    usedMinutes: 1500,
    grossAmount: 0,
    netAmount: 0,
    burnRatePerHour: null,
    budget: null,
    cycleStart: "2026-11-01",
    readAt: null,
    spendApp: true,
    enterprise: null,
    projection: projection && {
      outlook: "on_track",
      minutesPerDay: 100,
      projectedMinutes: 2600,
      runsOutAt: null,
      resetsAt: "2026-12-01T00:00:00.000Z",
      ...projection,
    },
  }) satisfies AccountUsage;

describe("paceText", () => {
  test("says when the minutes run out and that GitHub bills after", () => {
    expect(paceText(usage({ outlook: "runs_out", runsOutAt: "2026-11-23T14:00:00.000Z" }))).toBe(
      "At this pace, included minutes run out around Nov 23. GitHub bills jobs after that, until the Dec 1 reset.",
    );
  });

  test("names the minutes left unused when there's a surplus", () => {
    expect(paceText(usage({ outlook: "surplus", projectedMinutes: 1800 }))).toBe(
      "At this pace, about 1.2K of 3K min go unused by the Dec 1 reset.",
    );
  });

  test("projects the cycle's total when on track, and billed minutes once over", () => {
    expect(paceText(usage({}))).toBe("At this pace, about 2.6K of 3K min used by the Dec 1 reset.");
    expect(paceText(usage({ outlook: "over", projectedMinutes: 3800 }))).toBe(
      "At this pace, about 800 more billed min by the Dec 1 reset.",
    );
  });

  test("says nothing without a projection or a quota", () => {
    expect(paceText(usage(null))).toBeNull();
    expect(paceText(usage({}, null))).toBeNull();
  });
});
