import { describe, expect, test } from "vitest";
import { checkLabels } from "./repo-checks.ts";

const repo = {
  repository: "acme/app",
  path: "relayrunner.yml",
  error: null,
  prTitle: null,
  prDescription: null,
  lint: null,
};

describe("checkLabels", () => {
  test("names each check that's on, with its settings", () => {
    expect(checkLabels(repo)).toEqual([]);
    expect(
      checkLabels({
        ...repo,
        prTitle: { types: [] },
        prDescription: { minLength: 1 },
        lint: { tools: ["oxlint", "typos"], paths: [] },
      }),
    ).toEqual(["PR title", "PR description", "Lint (oxlint, typos)"]);
    expect(
      checkLabels({
        ...repo,
        prTitle: { types: ["feat", "fix"] },
        prDescription: { minLength: 50 },
      }),
    ).toEqual(["PR title (feat, fix)", "PR description (50+ characters)"]);
  });
});
