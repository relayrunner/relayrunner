import { describe, expect, test } from "vitest";
import { parseRepoConfig } from "./repo-config.ts";
import { repoChecksOf } from "./repo-checks.ts";

describe("repoChecksOf", () => {
  test("leaves out a repo with no relayrunner.yml", () => {
    expect(repoChecksOf("acme/app", { kind: "none" })).toBeNull();
  });

  test("lists the checks the file turns on", () => {
    const config = parseRepoConfig(
      ".github/relayrunner.yml",
      "checks:\n  pr-title: true\n  pr-description:\n    min-length: 50\n",
    );
    expect(repoChecksOf("acme/app", config)).toEqual({
      repository: "acme/app",
      path: ".github/relayrunner.yml",
      error: null,
      prTitle: { types: [] },
      prDescription: { minLength: 50 },
      lint: null,
    });
  });

  test("keeps an invalid file with its reason and every check off", () => {
    const config = parseRepoConfig("relayrunner.yml", "checks:\n  pr-titel: true\n");
    expect(repoChecksOf("acme/app", config)).toMatchObject({
      path: "relayrunner.yml",
      error: expect.stringContaining("pr-titel"),
      prTitle: null,
      prDescription: null,
      lint: null,
    });
  });
});
