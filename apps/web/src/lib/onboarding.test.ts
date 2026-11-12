import { describe, expect, test } from "vitest";
import { onboardingStep, shouldOpenInstall } from "./onboarding.ts";

const base = { hasWorkspace: false, outcome: undefined, opened: false };

describe("sending a new user straight to the GitHub App install", () => {
  test("happens with no workspace yet, since installing makes one (#316)", () => {
    expect(shouldOpenInstall(base)).toBe(true);
  });

  test("skips anyone already in a workspace, whatever their role", () => {
    expect(shouldOpenInstall({ ...base, hasWorkspace: true })).toBe(false);
  });

  test("stops once GitHub has reported back, such as a request to the org's owners", () => {
    expect(shouldOpenInstall({ ...base, outcome: "requested" })).toBe(false);
    expect(shouldOpenInstall({ ...base, outcome: "not_found" })).toBe(false);
  });

  test("redirects only once, so cancelling on GitHub doesn't loop", () => {
    expect(shouldOpenInstall({ ...base, opened: true })).toBe(false);
  });
});

describe("the /device step", () => {
  test("is Approve for anyone in a workspace", () => {
    expect(onboardingStep({ hasWorkspace: true, outcome: undefined })).toBe("approve");
  });

  test("is Approve after a request to an org's owners, before any workspace exists", () => {
    expect(onboardingStep({ hasWorkspace: false, outcome: "requested" })).toBe("approve");
  });

  test("is GitHub with no workspace, including after an error or a cancelled install", () => {
    expect(onboardingStep({ hasWorkspace: false, outcome: undefined })).toBe("github");
    expect(onboardingStep({ hasWorkspace: false, outcome: "not_found" })).toBe("github");
  });
});
