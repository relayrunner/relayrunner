import { describe, expect, test } from "vitest";
import { firstWorkspaceName, shouldOpenInstall } from "./onboarding.ts";

const owner = { role: "owner", installations: [] };
const base = { current: owner, unclaimedCount: 0, outcome: undefined, opened: false };

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

  test("keeps the Add choice for an unclaimed install", () => {
    expect(shouldOpenInstall({ ...base, unclaimedCount: 1 })).toBe(false);
  });

  test("stops once GitHub has reported back, such as a request to the org's owners", () => {
    expect(shouldOpenInstall({ ...base, outcome: "requested" })).toBe(false);
    expect(shouldOpenInstall({ ...base, outcome: "taken" })).toBe(false);
  });

  test("redirects only once, so cancelling on GitHub doesn't loop", () => {
    expect(shouldOpenInstall({ ...base, opened: true })).toBe(false);
  });

  test("leaves members, who can't install, on the GitHub step", () => {
    expect(shouldOpenInstall({ ...base, current: { role: "member", installations: [] } })).toBe(
      false,
    );
  });

  test("waits for a workspace", () => {
    expect(shouldOpenInstall({ ...base, current: null })).toBe(false);
  });
});

describe("a first workspace's name", () => {
  test("is the GitHub login, else the profile name", () => {
    expect(firstWorkspaceName("octocat", "The Octocat")).toBe("octocat");
    expect(firstWorkspaceName(null, "The Octocat")).toBe("The Octocat");
    expect(firstWorkspaceName(undefined, " ")).toBe("My workspace");
  });
});
