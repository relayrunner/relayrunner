import { describe, expect, it } from "vitest";
import { PLANS, RUNNER_CLOUD_IDS, startsAt, twoVcpuMinute } from "./plans.ts";

describe("plans", () => {
  it("offers the third-party runner clouds, not GitHub", () => {
    expect(RUNNER_CLOUD_IDS).toEqual([
      "blacksmith",
      "depot",
      "namespace",
      "warpbuild",
      "ubicloud",
      "boat",
    ]);
  });

  it("lists each provider's plans cheapest first", () => {
    for (const { plans } of Object.values(PLANS)) {
      const fees = plans.map((plan) => plan.feeUsd ?? Infinity);
      expect(fees).toEqual(fees.toSorted((a, b) => a - b));
    }
  });

  it("says what the cheapest plan costs", () => {
    expect(startsAt(PLANS.boat!)).toBe("$20/mo");
    expect(startsAt(PLANS.blacksmith!)).toBe("No monthly fee");
  });

  it("prices a 2 vCPU Linux minute from the price list, or the plan where the list has none", () => {
    expect(twoVcpuMinute("blacksmith")).toBeCloseTo(0.004);
    expect(twoVcpuMinute("depot")).toBeCloseTo(0.006);
    expect(twoVcpuMinute("boat")).toBeCloseTo(0.0003);
    expect(twoVcpuMinute("namespace")).toBe(0.003);
    expect(twoVcpuMinute("other")).toBeNull();
  });
});
