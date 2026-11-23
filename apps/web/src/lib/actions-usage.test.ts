import { describe, expect, test } from "vitest";
import { type AccountUsage, paceText } from "./actions-usage";

const usage = (used: number, quota: number | null = 3000): AccountUsage => ({
  installationId: 1,
  accountLogin: "your-org",
  accountType: "Organization",
  status: "ok",
  reason: null,
  plan: "team",
  quotaMinutes: quota,
  usedMinutes: used,
  grossAmount: 0,
  netAmount: 0,
  burnRatePerHour: null,
  budget: null,
  cycleStart: "2026-11-01",
  readAt: null,
  spendApp: true,
  enterprise: null,
});

// Halfway through November: 15 of 30 days gone.
const now = Date.parse("2026-11-16T00:00:00Z");

describe("paceText", () => {
  test("projects the month's total when the minutes will last", () => {
    expect(paceText(usage(1000), now)).toBe("At this pace, about 2,000 of 3,000 min by Dec 1.");
  });

  test("says when the minutes run out when they won't last", () => {
    expect(paceText(usage(2000), now)).toBe(
      "At this pace the included minutes run out around Nov 23, before the Dec 1 reset.",
    );
  });

  test("says nothing without a quota, on the cycle's first day, or once used up", () => {
    expect(paceText(usage(1000, null), now)).toBeNull();
    expect(paceText(usage(10), Date.parse("2026-11-01T12:00:00Z"))).toBeNull();
    expect(paceText(usage(3000), now)).toBeNull();
  });
});
