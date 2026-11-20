import { describe, expect, test, vi } from "vitest";
import type { JobTypeTimes } from "./job-types.ts";

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/utils", () => ({ count: String }));

const { change, summarize } = await import("./job-types.ts");

const MIN = 60_000;
const DAY_MS = 86_400_000;

const report: JobTypeTimes = {
  days: 2,
  start: 0,
  ai: true,
  compare: true,
  jobs: [
    {
      repository: "acme/app",
      workflow: "CI",
      job: "test",
      type: "test",
      runs: 4,
      ms: 8 * MIN,
      priorMs: 4 * MIN,
      byDay: [2 * MIN, 6 * MIN],
    },
    {
      repository: "acme/api",
      workflow: "CI",
      job: "build",
      type: "build",
      runs: 1,
      ms: 3 * MIN,
      priorMs: 3 * MIN,
      byDay: [3 * MIN, 0],
    },
    {
      repository: "acme/app",
      workflow: null,
      job: "misc",
      type: null,
      runs: 1,
      ms: MIN,
      priorMs: 0,
      byDay: [0, MIN],
    },
    // Only in the window before: counts toward its type's change, not its jobs.
    {
      repository: "acme/app",
      workflow: "CI",
      job: "old",
      type: "test",
      runs: 0,
      ms: 0,
      priorMs: 4 * MIN,
      byDay: [0, 0],
    },
  ],
};

describe("summarize", () => {
  test("adds jobs up by type in stacking order, with each day's split", () => {
    const summary = summarize(report);
    expect(summary.ms).toBe(12 * MIN);
    expect(summary.runs).toBe(6);
    expect(summary.types.map((t) => [t.key, t.ms, t.priorMs, t.jobs.length])).toEqual([
      ["test", 8 * MIN, 8 * MIN, 1],
      ["build", 3 * MIN, 3 * MIN, 1],
      ["none", MIN, 0, 1],
    ]);
    expect(summary.days).toEqual([
      { start: 0, ms: { test: 2 * MIN, build: 3 * MIN }, total: 5 * MIN },
      { start: DAY_MS, ms: { test: 6 * MIN, none: MIN }, total: 7 * MIN },
    ]);
    expect(change(summary.types[0]!)).toBe(0);
    // Too little before to compare.
    expect(change(summary.types[2]!)).toBeNull();
  });

  test("narrows to one repo", () => {
    const summary = summarize(report, "acme/api");
    expect(summary.types.map((t) => t.key)).toEqual(["build"]);
  });
});
