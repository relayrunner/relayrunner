import { describe, expect, test } from "vitest";
import { setupSteps } from "./admin-setup.ts";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-11-11T12:00:00Z");
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();

describe("setupSteps", () => {
  test("a step is stuck once the one before it is over a day old", () => {
    const steps = setupSteps(
      { signedUpAt: ago(50), installedAt: ago(30), machineAt: null, firstMachineJobAt: null },
      now,
    );
    expect(steps.map((s) => [s.label, !!s.at, s.stuck])).toEqual([
      ["Signed up", true, false],
      ["App installed", true, false],
      ["Machine connected", false, true],
      // Waits on the machine, which hasn't happened, so it isn't stuck yet.
      ["First job on a machine", false, false],
    ]);
    expect(steps[2]?.waitingSince).toBe(ago(30));
  });

  test("a step waiting under a day isn't stuck", () => {
    const steps = setupSteps(
      { signedUpAt: ago(5), installedAt: ago(5), machineAt: ago(2), firstMachineJobAt: null },
      now,
    );
    expect(steps.map((s) => s.stuck)).toEqual([false, false, false, false]);
  });
});
