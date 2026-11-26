import { describe, expect, test } from "vitest";
import { partOf, sortSteps, stepTimes } from "./step-phases.ts";

describe("partOf", () => {
  test.each([
    ["Set up job", "runner"],
    ["Complete job", "runner"],
    ["Post Run actions/checkout@v4", "runner"],
    ["Run actions/checkout@v4", "checkout"],
    ["Run useblacksmith/checkout@v1", "checkout"],
    ["Check out code", "checkout"],
    ["Run actions/setup-node@v4", "tools"],
    ["Run pnpm/action-setup@v4", "tools"],
    ["Set up Docker Buildx", "tools"],
    ["Run dtolnay/rust-toolchain@stable", "tools"],
    ["Run pnpm install --frozen-lockfile", "packages"],
    ["Run npm ci", "packages"],
    ["Run yarn", "packages"],
    ["Run pip install -r requirements.txt", "packages"],
    ["Install dependencies", "packages"],
    ["Run sudo apt-get update && sudo apt-get install -y libvips", "system"],
    ["Install system dependencies", "system"],
    ["Run brew install swiftlint", "system"],
    ["Run npx playwright install --with-deps", "browsers"],
    ["Install Playwright browsers", "browsers"],
    ["Run docker compose pull", "images"],
    ["Initialize containers", "images"],
    ["Run actions/cache@v4", "cache"],
    ["Run actions/cache/restore@v4", "cache"],
    ["Run Swatinem/rust-cache@v2", "cache"],
    ["Post Run actions/cache@v4", "cache"],
    ["Post Run actions/setup-node@v4", "cache"],
    ["Run pnpm test", "test"],
    ["Run yarn test", "test"],
    ["Test the Rust CLI", "test"],
    ["Build", "build"],
    ["Run pnpm --filter web build", "build"],
    ["Run pnpm check", "other"],
    ["Lint", "other"],
  ])("%s is %s", (name, part) => {
    expect(partOf(name)).toBe(part);
  });

  test("sorts work no rule names by the job's type", () => {
    expect(partOf("Run pnpm check", "test")).toBe("test");
    expect(partOf("Run pnpm check", "e2e")).toBe("test");
    expect(partOf("Run pnpm check", "build")).toBe("build");
    expect(partOf("Run pnpm check", "lint")).toBe("other");
    expect(partOf("Build", "test")).toBe("build");
  });
});

describe("sortSteps", () => {
  const cached = (names: string[]) => sortSteps(names, null).cached;

  test("ties a cache step to what its name says it holds", () => {
    expect(cached(["Cache pnpm store", "Cache Playwright browsers", "Run pnpm test"])).toEqual(
      new Set(["packages", "browsers"]),
    );
  });

  test("counts a setup action that saves its cache for packages", () => {
    expect(cached(["Run actions/setup-node@v4", "Post Run actions/setup-node@v4"])).toEqual(
      new Set(["packages"]),
    );
  });

  test("ties nothing to a cache step that doesn't say what it holds", () => {
    expect(cached(["Run actions/cache@v4", "Post Run actions/cache@v4"]).size).toBe(0);
  });

  test("ignores steps that only mention what a cache would hold", () => {
    expect(cached(["Run pnpm install", "Install Playwright browsers"]).size).toBe(0);
  });

  test("gives each name its part", () => {
    expect(sortSteps(["Run pnpm check", "Run pnpm check"], "test").parts).toEqual(
      new Map([["Run pnpm check", "test"]]),
    );
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
