import { describe, expect, test } from "vitest";
import { shouldOpenInstall } from "./onboarding.ts";

const owner = { role: "owner", installations: [] };
const base = { current: owner, outcome: undefined, opened: false };

describe("sending a new user straight to the GitHub App install", () => {
  test("happens when installing is the only thing left", () => {
    expect(shouldOpenInstall(base)).toBe(true);
    expect(shouldOpenInstall({ ...base, current: { role: "admin", installations: [] } })).toBe(
      true,
    );
  });

  test("skips a workspace that already has an installation", () => {
    expect(shouldOpenInstall({ ...base, current: { role: "owner", installations: [{}] } })).toBe(
      false,
    );
  });

  test("stops once GitHub has reported back, such as a request to the org's owners", () => {
    expect(shouldOpenInstall({ ...base, outcome: "requested" })).toBe(false);
    expect(shouldOpenInstall({ ...base, outcome: "not_found" })).toBe(false);
  });

  test("redirects only once, so cancelling on GitHub doesn't loop", () => {
    expect(shouldOpenInstall({ ...base, opened: true })).toBe(false);
  });

  test("leaves members, who can't install, on the GitHub step", () => {
    expect(shouldOpenInstall({ ...base, current: { role: "member", installations: [] } })).toBe(
      false,
    );
  });

  test("happens with no workspace yet, since installing makes one (#316)", () => {
    expect(shouldOpenInstall({ ...base, current: null })).toBe(true);
    expect(shouldOpenInstall({ ...base, current: null, opened: true })).toBe(false);
  });
});
