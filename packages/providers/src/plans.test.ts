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
      "starsling",
      "monkci",
      "runloft",
      "latchkey",
      "berrybox",
      "celesto",
      "instabox",
      "lizard",
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
    expect(startsAt(PLANS.blacksmith!)).toBe("Pay as you go");
    // A one-machine free tier or a trial isn't where real CI starts.
    expect(startsAt(PLANS.instabox!)).toBe("$20/mo");
    expect(startsAt(PLANS.monkci!)).toBe("$20/mo");
    expect(startsAt(PLANS.lizard!)).toBe("$19/mo");
  });

  it("prices a 2 vCPU Linux minute from the price list, or the plan where the list has none", () => {
    expect(twoVcpuMinute("blacksmith")).toBeCloseTo(0.004);
    expect(twoVcpuMinute("depot")).toBeCloseTo(0.006);
    expect(twoVcpuMinute("boat")).toBeCloseTo(0.0003);
    expect(twoVcpuMinute("namespace")).toBe(0.006);
    expect(twoVcpuMinute("berrybox")).toBe(0.002);
    // Listed runner clouds come from the price list, at a 2 vCPU size.
    expect(twoVcpuMinute("latchkey")).toBe(0.0025);
    expect(twoVcpuMinute("celesto")).toBe(0.0005);
    expect(twoVcpuMinute("instabox")).toBeCloseTo(0.000283, 6);
    expect(twoVcpuMinute("monkci")).toBe(0.004);
    expect(twoVcpuMinute("lizard")).toBeCloseTo(0.00027, 6);
    expect(twoVcpuMinute("other")).toBeNull();
  });
});
