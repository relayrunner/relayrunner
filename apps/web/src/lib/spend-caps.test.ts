import type { RunnerStep } from "@relayrunner/runner-order";
import { describe, expect, test } from "vitest";
import type { AccountUsage } from "./actions-usage";
import { sampleFreeMinutes } from "./sample/free-minutes.ts";
import { barMarks, capText, handoffText, unreachableText } from "./spend-caps";

const account: AccountUsage = {
  installationId: 1,
  accountLogin: "acme",
  accountType: "Organization",
  status: "ok",
  reason: null,
  plan: "team",
  quotaMinutes: 3000,
  usedMinutes: 1200,
  grossAmount: 0,
  netAmount: 0,
  burnRatePerHour: null,
  budget: null,
  cycleStart: "2026-11-01",
  readAt: null,
  spendApp: true,
  enterprise: null,
};
const blacksmith = { blacksmith: sampleFreeMinutes("blacksmith", true) };

describe("capText", () => {
  test("says each kind of cap the way its button reads", () => {
    const cap = (step: RunnerStep) => capText(step, [account], blacksmith);
    expect(cap({ key: "machine" })).toBe("When available");
    expect(cap({ key: "github", limit: { percent: 80 } })).toBe("Up to 2,400 minutes");
    expect(cap({ key: "blacksmith", limit: { percent: 90 } })).toBe("Up to 2,700 minutes");
    expect(cap({ key: "github", spendLimit: { usd: 1500 } })).toBe("Up to $1,500/month");
    expect(cap({ key: "boat" })).toBe("No cap");
    // Accounts with different quotas give a range; with no quota at all, the cap is a share.
    const bigger = { ...account, installationId: 2, quotaMinutes: 50_000 };
    expect(capText({ key: "github", limit: { percent: 80 } }, [account, bigger])).toBe(
      "Up to 2,400–40,000 minutes",
    );
    expect(capText({ key: "github", limit: { percent: 80 } }, [])).toBe("Up to 80% of minutes");
  });
});

describe("handoffText", () => {
  const handoff = (step: RunnerStep) => handoffText(step, [account], blacksmith);

  test("says what hands a job on, from how the step above is set up", () => {
    expect(handoff({ key: "machine" })).toEqual({
      text: "When every machine is busy or offline",
      warn: false,
    });
    expect(handoff({ key: "github", limit: { percent: 80 } }).text).toBe(
      "Once 2,400 minutes are used",
    );
    expect(handoff({ key: "blacksmith", limit: { percent: 90 } }).text).toBe(
      "Once 2,700 minutes are used",
    );
    expect(handoff({ key: "depot", spendLimit: { usd: 50 } }).text).toBe("Once $50/month is spent");
  });

  test("warns under a step with no cap, Boat included until it's connected", () => {
    for (const key of ["github", "boat"] as const) {
      const { text, warn } = handoff({ key });
      expect(warn).toBe(true);
      expect(text).toContain("so the steps below rarely run");
    }
    expect(handoff({ key: "boat" }).connect).toBe("Connect Boat");
    expect(handoff({ key: "github" }).connect).toBeUndefined();
  });

  test("says Boat passes jobs on at its start limits once it's connected", () => {
    expect(handoffText({ key: "boat" }, [account], blacksmith, true)).toEqual({
      text: "When Boat reaches its plan's limit on job starts",
      warn: false,
    });
  });
});

describe("unreachableText", () => {
  test("flags a repeat whose cap the same provider above already passed", () => {
    const steps: RunnerStep[] = [
      { key: "blacksmith", limit: { percent: 90 } },
      { key: "github", limit: { percent: 80 } },
      { key: "blacksmith", limit: { percent: 50 } },
      { key: "depot", spendLimit: { usd: 20 } },
      { key: "depot", spendLimit: { usd: 50 } },
      { key: "github", spendLimit: { usd: 100 } },
      { key: "github" },
    ];
    expect(steps.map((_, index) => unreachableText(steps, index))).toEqual([
      null,
      null,
      "Never reached: the Blacksmith step above has the same or a higher cap.",
      null,
      // A higher cap than the step above: it takes jobs between $20 and $50.
      null,
      // A different kind of cap than the GitHub step above.
      null,
      null,
    ]);
  });
});

describe("barMarks", () => {
  test("keeps the cap's tick at least 10% from either end", () => {
    // Under the cap, the tick sits where the cap falls in the quota.
    expect(barMarks(1200, 2400, 3000)).toEqual({ fill: 40, tick: 80 });
    // A cap at the quota is pulled in from the right end.
    expect(barMarks(0, 3000, 3000).tick).toBeCloseTo(90);
    // Five times over a dollar cap, the tick stops 10% from the left and the fill is full.
    const over = barMarks(500, 50, 500);
    expect(over.tick).toBeCloseTo(10);
    expect(over.fill).toBe(100);
  });
});

describe("Groundbox", () => {
  const groundbox = { groundbox: sampleFreeMinutes("groundbox", true) };
  test("caps and hands off in free minutes, and a connected uncapped step passes held jobs on", () => {
    expect(capText({ key: "groundbox", limit: { percent: 50 } }, [], groundbox)).toBe(
      "Up to 1,500 minutes",
    );
    expect(handoffText({ key: "groundbox" }, [], groundbox)).toEqual({
      text: "When Groundbox would hold the job",
      warn: false,
    });
    const notConnected = { groundbox: sampleFreeMinutes("groundbox", false) };
    expect(handoffText({ key: "groundbox" }, [], notConnected).warn).toBe(true);
  });

  test("a minutes limit on a plan without free minutes shows no made-up cap", () => {
    const sponsored = {
      groundbox: {
        ...sampleFreeMinutes("groundbox", true),
        status: "not_available" as const,
        reason: "no_free_minutes" as const,
        plan: "sponsored",
      },
    };
    const limited = { key: "groundbox" as const, limit: { percent: 80 } };
    expect(capText(limited, [], sponsored)).toBe("No minutes to track");
    expect(handoffText(limited, [], sponsored)).toEqual({
      text: "When Groundbox would hold the job",
      warn: false,
    });
  });
});
