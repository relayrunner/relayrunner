import { describe, expect, test } from "vitest";
import { DEFAULT_RUNNER_ORDER, readRunnerOrder, runnerOrderSchema } from "./index.ts";

describe("runnerOrderSchema", () => {
  test("accepts the providers in any order, or one alone", () => {
    for (const steps of [
      [{ key: "blacksmith" }, { key: "machine" }, { key: "github" }],
      [{ key: "machine" }, { key: "blacksmith" }],
      [{ key: "blacksmith" }],
      [{ key: "machine" }, { key: "github" }],
      [{ key: "github" }, { key: "machine" }],
      [{ key: "github" }],
      [{ key: "machine" }],
    ]) {
      expect(runnerOrderSchema.safeParse({ steps }).success).toBe(true);
    }
  });

  test("rejects an empty order", () => {
    const result = runnerOrderSchema.safeParse({ steps: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Add at least one provider.");
  });

  test("rejects a provider listed twice", () => {
    const result = runnerOrderSchema.safeParse({
      steps: [{ key: "machine" }, { key: "github" }, { key: "machine" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["steps", 2, "key"],
      message: "Self-hosted is already in the order.",
    });
  });

  test("GitHub-hosted may come twice, once with a limit and once without", () => {
    const steps = [
      { key: "github", limit: { percent: 80 } },
      { key: "machine" },
      { key: "github" },
    ];
    expect(runnerOrderSchema.parse({ steps })).toEqual({ steps });
  });

  test("rejects GitHub-hosted twice with the same rule", () => {
    for (const steps of [
      [{ key: "github" }, { key: "github" }],
      [
        { key: "github", limit: { percent: 80 } },
        { key: "github", limit: { percent: 90 } },
      ],
    ]) {
      const result = runnerOrderSchema.safeParse({ steps });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["steps", 1, "key"]);
    }
  });

  test("a limit is a whole percent from 1 to 100", () => {
    for (const percent of [0, 101, 80.5]) {
      const steps = [{ key: "github", limit: { percent } }];
      expect(runnerOrderSchema.safeParse({ steps }).success).toBe(false);
    }
    const steps = [{ key: "github", limit: { percent: 100 } }];
    expect(runnerOrderSchema.safeParse({ steps }).success).toBe(true);
  });

  test("rejects unknown keys and labels on steps", () => {
    expect(runnerOrderSchema.safeParse({ steps: [{ key: "buildkite" }] }).success).toBe(false);
    const labelled = runnerOrderSchema.parse({ steps: [{ key: "github", label: "macos" }] });
    expect(labelled).toEqual({ steps: [{ key: "github" }] });
  });
});

describe("readRunnerOrder", () => {
  test("a workspace without an order gets machine then github", () => {
    expect(readRunnerOrder(null)).toEqual(DEFAULT_RUNNER_ORDER);
    expect(DEFAULT_RUNNER_ORDER.steps.map((step) => step.key)).toEqual(["machine", "github"]);
  });

  test("a stored order reads back", () => {
    expect(readRunnerOrder('{"steps":[{"key":"github"}]}')).toEqual({ steps: [{ key: "github" }] });
  });

  test("an unreadable value falls back to the default", () => {
    expect(readRunnerOrder("not json")).toEqual(DEFAULT_RUNNER_ORDER);
    expect(readRunnerOrder('{"steps":[]}')).toEqual(DEFAULT_RUNNER_ORDER);
  });
});
