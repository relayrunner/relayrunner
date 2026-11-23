import { describe, expect, test } from "vitest";
import { phaseOf, stepTimes } from "./step-phases.ts";

describe("phaseOf", () => {
  test.each([
    ["Set up job", "setup"],
    ["Run actions/setup-node@v4", "setup"],
    ["Run pnpm/action-setup@v4", "setup"],
    ["Set up Docker Buildx", "setup"],
    ["Run dtolnay/rust-toolchain@stable", "setup"],
    ["Run actions/checkout@v4", "checkout"],
    ["Check out code", "checkout"],
    ["Run pnpm install --frozen-lockfile", "dependencies"],
    ["Run npm ci", "dependencies"],
    ["Run yarn", "dependencies"],
    ["Run pip install -r requirements.txt", "dependencies"],
    ["Install dependencies", "dependencies"],
    ["Run actions/cache@v4", "cache"],
    ["Run actions/cache/restore@v4", "cache"],
    ["Run Swatinem/rust-cache@v2", "cache"],
    ["Post Run actions/cache@v4", "cache"],
    ["Post Run actions/setup-node@v4", "cache"],
    ["Post Run actions/checkout@v4", "cleanup"],
    ["Complete job", "cleanup"],
    ["Run pnpm test", "work"],
    ["Run yarn test", "work"],
    ["Build", "work"],
  ])("%s is %s", (name, phase) => {
    expect(phaseOf(name)).toBe(phase);
  });
});

describe("stepTimes", () => {
  test("keeps steps that took time, in whole seconds", () => {
    expect(
      stepTimes([
        step("Set up job", "2026-11-20T10:00:00Z", "2026-11-20T10:00:02Z"),
        step("Lint", "2026-11-20T10:00:02Z", "2026-11-20T10:01:12Z"),
        { ...step("Deploy", null, null), conclusion: "skipped" },
        step("Never started", null, null),
        step("Post Run actions/checkout@v4", "2026-11-20T10:01:12Z", "2026-11-20T10:01:12Z"),
      ]),
    ).toEqual([
      ["Set up job", 2],
      ["Lint", 70],
    ]);
  });

  test("is null without steps", () => {
    expect(stepTimes(undefined)).toBeNull();
    expect(stepTimes([])).toBeNull();
  });
});

function step(name: string, startedAt: string | null, completedAt: string | null) {
  return { name, number: 1, conclusion: "success", startedAt, completedAt };
}
