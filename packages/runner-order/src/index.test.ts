import { describe, expect, test } from "vitest";
import {
  DEFAULT_RUNNER_ORDER,
  isAutoRelay,
  noSizeText,
  preferFirst,
  readRunnerOrder,
  relayInputs,
  resolveAutoInputs,
  runnerOrderSchema,
} from "./index.ts";

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

  test("rejects Self-hosted listed twice", () => {
    const result = runnerOrderSchema.safeParse({
      steps: [{ key: "machine" }, { key: "github" }, { key: "machine" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["steps", 2, "key"],
      message: "Self-hosted is already in the order.",
    });
  });

  test("a hosted provider may come back any number of times, with any cap", () => {
    const steps = [
      { key: "blacksmith", limit: { percent: 50 } },
      { key: "github", limit: { percent: 80 } },
      { key: "blacksmith", limit: { percent: 90 } },
      { key: "github", spendLimit: { usd: 100 } },
      { key: "depot", spendLimit: { usd: 20 } },
      { key: "depot", spendLimit: { usd: 50 } },
      { key: "github" },
      { key: "github" },
    ];
    expect(runnerOrderSchema.parse({ steps })).toEqual({ steps });
  });

  test("GitHub-hosted takes a spend cap, from its own billing", () => {
    const steps = [{ key: "github", spendLimit: { usd: 100 } }];
    expect(runnerOrderSchema.parse({ steps })).toEqual({ steps });
  });

  test("a step takes a minutes limit or a spend limit, not both", () => {
    const steps = [{ key: "blacksmith", limit: { percent: 80 }, spendLimit: { usd: 50 } }];
    const result = runnerOrderSchema.safeParse({ steps });
    expect(result.error?.issues[0]?.message).toBe(
      "Pick a minutes limit or a spend limit, not both.",
    );
  });

  test("only GitHub-hosted and Blacksmith take a minutes limit", () => {
    const parsed = runnerOrderSchema.parse({ steps: [{ key: "depot", limit: { percent: 80 } }] });
    expect(parsed).toEqual({ steps: [{ key: "depot" }] });
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

describe("auto relays", () => {
  const label = (key: string) => (key === "github" ? null : `${key}-8`);

  test("a relay with no inputs hands every provider to the Router", () => {
    const inputs = relayInputs({});
    expect(isAutoRelay(inputs)).toBe(true);
    const resolved = resolveAutoInputs(inputs, label);
    expect(resolved.machine).toEqual(["self-hosted"]);
    expect(resolved.blacksmith).toEqual(["blacksmith-8"]);
    // GitHub has no runner that big here, so it stays auto and the Router skips it.
    expect(resolved.github).toEqual(["auto"]);
  });

  test("only the providers set to auto get a label", () => {
    const inputs = relayInputs({ blacksmith: ["Auto"], github: ["ubuntu-latest"] });
    expect(isAutoRelay(inputs)).toBe(true);
    const resolved = resolveAutoInputs(inputs, label);
    expect(resolved.blacksmith).toEqual(["blacksmith-8"]);
    expect(resolved.github).toEqual(["ubuntu-latest"]);
    expect(resolved.depot).toEqual([]);
    expect(resolved.machine).toEqual([]);
  });

  test("a relay that names its labels runs as written", () => {
    expect(isAutoRelay(relayInputs({ github: ["ubuntu-latest"] }))).toBe(false);
  });

  test("a shape makes a relay auto, every provider it doesn't name included", () => {
    const inputs = relayInputs({ github: ["my-org-linux-16core"] });
    const shape = { cpus: 8 };
    expect(isAutoRelay(inputs, shape)).toBe(true);
    const resolved = resolveAutoInputs(inputs, label, shape);
    expect(resolved.github).toEqual(["my-org-linux-16core"]);
    expect(resolved.blacksmith).toEqual(["blacksmith-8"]);
    expect(resolved.machine).toEqual(["self-hosted", "Linux"]);
  });

  test("a shape's OS and arch narrow the machines", () => {
    const resolved = resolveAutoInputs(relayInputs({}), label, { os: "macos", arch: "arm64" });
    expect(resolved.machine).toEqual(["self-hosted", "macOS", "ARM64"]);
  });

  test("a named machine keeps its labels and adds only the OS and arch the shape says", () => {
    const named = relayInputs({ machine: ["self-hosted", "gpu"] });
    expect(resolveAutoInputs(named, label, { cpus: 4 }).machine).toEqual(["self-hosted", "gpu"]);
    expect(resolveAutoInputs(named, label, { arch: "arm64" }).machine).toEqual([
      "self-hosted",
      "gpu",
      "ARM64",
    ]);
    const linux = relayInputs({ machine: ["self-hosted", "linux"] });
    expect(resolveAutoInputs(linux, label, { os: "linux" }).machine).toEqual([
      "self-hosted",
      "linux",
    ]);
  });

  test("no shape leaves a relay as it was", () => {
    expect(isAutoRelay(relayInputs({ github: ["ubuntu-latest"] }), {})).toBe(false);
    expect(resolveAutoInputs(relayInputs({}), label, {}).machine).toEqual(["self-hosted"]);
  });

  test("noSizeText names the platform when the relay set a shape", () => {
    expect(noSizeText("blacksmith", 8, "macos")).toBe(
      "Blacksmith has no macOS runner with 8 vCPU or more",
    );
    expect(noSizeText("ubicloud", undefined, "macos")).toBe("Ubicloud has no macOS runner");
    expect(noSizeText("github", 4)).toBe("GitHub-hosted has no runner with 4 vCPU or more");
  });

  test("preferFirst moves a provider to the top", () => {
    const order = {
      steps: [{ key: "machine" as const }, { key: "github" as const }, { key: "depot" as const }],
    };
    expect(preferFirst(order, "depot").steps.map((s) => s.key)).toEqual([
      "depot",
      "machine",
      "github",
    ]);
    expect(preferFirst(order, null)).toBe(order);
  });
});
