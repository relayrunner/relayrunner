import { describe, expect, test } from "vitest";
import {
  containerRunnerAllowed,
  containerRunnerGroupId,
  IDLE_LIMIT_MS,
  MAX_LIFETIME_MS,
  usesContainerRunner,
  watchStep,
} from "./container-runner.ts";

describe("usesContainerRunner", () => {
  test("matches the label in any case", () => {
    expect(usesContainerRunner(["RelayRunner-Container"])).toBe(true);
    expect(usesContainerRunner(["relayrunner", "ubuntu-latest"])).toBe(false);
  });
});

describe("containerRunnerAllowed", () => {
  test("allows listed orgs only, ignoring case and spaces", () => {
    expect(containerRunnerAllowed("relayrunner, Acme", "acme")).toBe(true);
    expect(containerRunnerAllowed("relayrunner", "acme")).toBe(false);
    expect(containerRunnerAllowed(undefined, "relayrunner")).toBe(false);
    expect(containerRunnerAllowed("", "relayrunner")).toBe(false);
  });
});

describe("watchStep", () => {
  const startedAt = 1_000_000;
  const at = (age: number) => startedAt + age;

  test("is done once the container exits", () => {
    expect(watchStep({ running: false, runner: "busy", startedAt, now: at(60_000) })).toBe("done");
  });

  test("waits while the job runs or the runner is still new", () => {
    expect(
      watchStep({ running: true, runner: "busy", startedAt, now: at(IDLE_LIMIT_MS * 2) }),
    ).toBe("wait");
    expect(watchStep({ running: true, runner: "idle", startedAt, now: at(60_000) })).toBe("wait");
  });

  test("stops a container whose runner is gone, never got a job, or ran too long", () => {
    expect(watchStep({ running: true, runner: "gone", startedAt, now: at(60_000) })).toBe(
      "stop_finished",
    );
    expect(
      watchStep({ running: true, runner: "idle", startedAt, now: at(IDLE_LIMIT_MS + 1) }),
    ).toBe("stop_idle");
    expect(
      watchStep({ running: true, runner: "busy", startedAt, now: at(MAX_LIFETIME_MS + 1) }),
    ).toBe("stop_timeout");
  });
});

describe("containerRunnerGroupId", () => {
  test("picks the Default Public group by name, or falls back", () => {
    const groups = [
      { id: 1, name: "Default" },
      { id: 4, name: "default public" },
    ];
    expect(containerRunnerGroupId(groups, 1)).toBe(4);
    expect(containerRunnerGroupId([{ id: 1, name: "Default" }], 1)).toBe(1);
  });
});
