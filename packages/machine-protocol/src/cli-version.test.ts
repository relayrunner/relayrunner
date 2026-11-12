import { expect, test } from "vitest";
import { isNewerVersion } from "./cli-version.ts";

test("compares plain releases only", () => {
  expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
  expect(isNewerVersion("1.0.0", "0.99.0")).toBe(true);
  expect(isNewerVersion("0.6.0", "0.6.0")).toBe(false);
  expect(isNewerVersion("0.5.9", "0.6.0")).toBe(false);
  expect(isNewerVersion("0.7.0-beta.1", "0.6.0")).toBe(false);
  expect(isNewerVersion("0.7.0", "0.7.0-beta.1")).toBe(false);
});
