import { describe, expect, test } from "vitest";
import {
  afterAttempt,
  MAX_ATTEMPTS,
  pickJobIdFromRunnerName,
  pickRunnerName,
} from "./pick-attempts.ts";

describe("afterAttempt", () => {
  test("re-arms a job that is still queued", () => {
    expect(afterAttempt("queued", 1)).toBe("rearm");
    expect(afterAttempt("queued", MAX_ATTEMPTS - 1)).toBe("rearm");
  });

  test("gives up once the job has used its attempts", () => {
    expect(afterAttempt("queued", MAX_ATTEMPTS)).toBe("give_up");
  });

  test("stops for a job that is running, finished or gone", () => {
    expect(afterAttempt("in_progress", 1)).toBe("done");
    expect(afterAttempt("completed", 1)).toBe("done");
    expect(afterAttempt(null, 1)).toBe("done");
  });
});

describe("pick runner names", () => {
  test("round-trip the job id, with or without an attempt", () => {
    expect(pickJobIdFromRunnerName(pickRunnerName(128907696567))).toBe(128907696567);
    expect(pickRunnerName(42, 3)).toBe("relayrunner-pick-42-3");
    expect(pickJobIdFromRunnerName(pickRunnerName(42, 3))).toBe(42);
  });

  test("ignore other runners", () => {
    expect(pickJobIdFromRunnerName("relayrunner-container-42")).toBeNull();
    expect(pickJobIdFromRunnerName("Atticuss-MacBook-Pro")).toBeNull();
    expect(pickJobIdFromRunnerName("relayrunner-pick-abc")).toBeNull();
  });
});
