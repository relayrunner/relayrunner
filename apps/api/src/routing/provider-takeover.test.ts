import { describe, expect, test } from "vitest";
import { FIRST_BACKOFF_MS, MAX_BACKOFF_MS, TRIAL_TIMEOUT_MS } from "./provider-health.ts";
import { missed, missGate, takeoverMessage } from "./provider-takeover.ts";

describe("provider misses per repo", () => {
  test("the first miss skips the provider for the repo, and a missed trial backs off further", () => {
    const first = missed(undefined, 0);
    expect(first).toEqual({
      missedAt: 0,
      retryAt: FIRST_BACKOFF_MS,
      backoffMs: FIRST_BACKOFF_MS,
      trialAt: null,
    });
    expect(missGate(first, 1)).toEqual({ cause: "missed", retryAt: FIRST_BACKOFF_MS });
    const again = missed(first, 100);
    expect(again.backoffMs).toBe(FIRST_BACKOFF_MS * 2);
    expect(again.retryAt).toBe(100 + FIRST_BACKOFF_MS * 2);
    let state = again;
    for (let i = 0; i < 10; i++) state = missed(state, 0);
    expect(state.backoffMs).toBe(MAX_BACKOFF_MS);
  });

  test("once the wait is over one job goes as the trial, then the rest wait for it", () => {
    expect(missGate(undefined, 0)).toBe("ok");
    const state = missed(undefined, 0);
    expect(missGate(state, state.retryAt)).toBe("trial");
    const out = { ...state, trialAt: state.retryAt };
    expect(missGate(out, state.retryAt + 1)).toMatchObject({ cause: "missed" });
    // A trial that never got an answer lets another through.
    expect(missGate(out, state.retryAt + TRIAL_TIMEOUT_MS)).toBe("trial");
  });

  test("the ended job names the provider and what to check", () => {
    expect(takeoverMessage("groundbox")).toMatch(
      /^Groundbox didn't pick up this job within a minute.*Groundbox's GitHub App may not have access to this repository/,
    );
  });
});
