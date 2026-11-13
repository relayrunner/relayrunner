import { describe, expect, test } from "vitest";
import { analyticsEnabled } from "./analytics";

describe("analyticsEnabled", () => {
  test("sends from production builds on the live domain, whichever it is", () => {
    expect(analyticsEnabled("app.relayrunner.app", true)).toBe(true);
    expect(analyticsEnabled("app.relayrunner.dev", true)).toBe(true);
  });

  test("stays off in dev builds, on localhost and on preview URLs", () => {
    expect(analyticsEnabled("app.relayrunner.app", false)).toBe(false);
    expect(analyticsEnabled("localhost", true)).toBe(false);
    expect(analyticsEnabled("feat-x-relayrunner-app.relayrun.workers.dev", true)).toBe(false);
  });
});
