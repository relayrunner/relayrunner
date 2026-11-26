import { describe, expect, test } from "vitest";
import {
  prDescriptionCheckRun,
  prTitleCheckRun,
  pullRequestCheckRuns,
} from "./pull-request-checks.ts";
import { parseRepoConfig, type ConfigResult } from "./repo-config.ts";

type Config = Extract<ConfigResult, { kind: "config" }>;
const config = (text: string) => parseRepoConfig("relayrunner.yml", text) as Config;
const on = config("checks:\n  pr-title: true\n");

describe("prTitleCheckRun", () => {
  test("posts nothing with the check off", () => {
    expect(prTitleCheckRun(config("checks:\n  pr-title: false\n"), "Add checks", "abc")).toBeNull();
  });

  test("passes a Conventional Commit title", () => {
    expect(prTitleCheckRun(on, "feat(api): add checks", "abc")).toEqual({
      name: "PR title",
      headSha: "abc",
      conclusion: "success",
      title: "Conventional Commit title",
      summary: '"feat(api): add checks" is a Conventional Commit.',
    });
  });

  test("fails any other title with how to fix it", () => {
    const check = prTitleCheckRun(on, "Add checks", "abc");
    expect(check?.conclusion).toBe("failure");
    expect(check?.summary).toContain("Write it as type(scope): description");
  });

  test("honours the configured types", () => {
    const docs = config("checks:\n  pr-title:\n    types: [docs]\n");
    expect(prTitleCheckRun(docs, "docs: x", "abc")?.conclusion).toBe("success");
    expect(prTitleCheckRun(docs, "feat: x", "abc")?.conclusion).toBe("failure");
  });
});

describe("prDescriptionCheckRun", () => {
  const described = config("checks:\n  pr-description: true\n");

  test("posts nothing with the check off", () => {
    expect(prDescriptionCheckRun(on, "", "abc")).toBeNull();
  });

  test("passes any description", () => {
    expect(prDescriptionCheckRun(described, "Fixes the retry loop.", "abc")).toEqual({
      name: "PR description",
      headSha: "abc",
      conclusion: "success",
      title: "Has a description",
      summary: "The pull request has a description.",
    });
  });

  test("fails an empty description or an untouched template", () => {
    expect(prDescriptionCheckRun(described, "  \n ", "abc")).toMatchObject({
      conclusion: "failure",
      title: "No description",
    });
    const template = "<!-- What does this change, and why? -->\n\n<!-- Screenshots -->\n";
    expect(prDescriptionCheckRun(described, template, "abc")?.conclusion).toBe("failure");
    expect(prDescriptionCheckRun(described, "<!-- unclosed hint", "abc")?.conclusion).toBe(
      "failure",
    );
    expect(prDescriptionCheckRun(described, `${template}Adds a check.`, "abc")?.conclusion).toBe(
      "success",
    );
  });

  test("asks for the configured length", () => {
    const long = config("checks:\n  pr-description:\n    min-length: 20\n");
    expect(prDescriptionCheckRun(long, "Fixes   a\nbug.", "abc")).toMatchObject({
      conclusion: "failure",
      title: "Description too short",
      summary: "The description has 12 characters. This repo asks for at least 20.",
    });
    expect(prDescriptionCheckRun(long, "Fixes a bug in the retry loop.", "abc")?.conclusion).toBe(
      "success",
    );
  });
});

describe("pullRequestCheckRuns", () => {
  const both = config("checks:\n  pr-title: true\n  pr-description: true\n");
  const pr = { number: 3, title: "feat: x", body: "Adds x.", headSha: "abc", changed: null };
  const names = (checks: { name: string }[]) => checks.map((check) => check.name);

  test("posts nothing without a config", () => {
    expect(pullRequestCheckRuns({ kind: "none" }, pr)).toEqual([]);
  });

  test("posts every check that's on", () => {
    expect(names(pullRequestCheckRuns(both, pr))).toEqual(["PR title", "PR description"]);
    expect(names(pullRequestCheckRuns(on, pr))).toEqual(["PR title"]);
  });

  test("an edit posts only the checks for what changed", () => {
    const edited = (...changed: string[]) => names(pullRequestCheckRuns(both, { ...pr, changed }));
    expect(edited("title")).toEqual(["PR title"]);
    expect(edited("body")).toEqual(["PR description"]);
    expect(edited("title", "body")).toEqual(["PR title", "PR description"]);
  });

  test("fails once with the reason when the config is invalid", () => {
    const bad = parseRepoConfig("relayrunner.yml", "checks:\n  pr-titel: true\n");
    expect(pullRequestCheckRuns(bad, pr)).toEqual([
      expect.objectContaining({ conclusion: "failure", title: "relayrunner.yml is invalid" }),
    ]);
  });
});

describe("parseRepoConfig", () => {
  test("reads pr-title as on, off, or with types", () => {
    expect(on).toEqual({
      kind: "config",
      path: "relayrunner.yml",
      prTitle: { types: [] },
      prDescription: null,
      lint: null,
      retry: null,
    });
    expect(parseRepoConfig("p", "")).toEqual({
      kind: "config",
      path: "p",
      prTitle: null,
      prDescription: null,
      lint: null,
      retry: null,
    });
    expect(parseRepoConfig("p", "checks:\n  pr-title:\n    types: feat, fix\n")).toEqual({
      kind: "config",
      path: "p",
      prTitle: { types: ["feat", "fix"] },
      prDescription: null,
      lint: null,
      retry: null,
    });
  });

  test("reads pr-description as on, off, or with a length", () => {
    expect(parseRepoConfig("p", "checks:\n  pr-description: true\n")).toMatchObject({
      prDescription: { minLength: 1 },
    });
    expect(parseRepoConfig("p", "checks:\n  pr-description: false\n")).toMatchObject({
      prDescription: null,
    });
    expect(parseRepoConfig("p", "checks:\n  pr-description:\n    min-length: 50\n")).toMatchObject({
      prDescription: { minLength: 50 },
    });
    expect(parseRepoConfig("p", "checks:\n  pr-description:\n    min-length: 0\n").kind).toBe(
      "invalid",
    );
    expect(parseRepoConfig("p", "checks:\n  pr-description:\n    min: 5\n").kind).toBe("invalid");
  });

  test("reads retry as on, off, or with settings", () => {
    expect(parseRepoConfig("p", "retry: true\n")).toMatchObject({ retry: {} });
    expect(parseRepoConfig("p", "retry: false\n")).toMatchObject({ retry: false });
    expect(parseRepoConfig("p", "retry:\n  runner: other\n  max: 2\n")).toMatchObject({
      retry: { runner: "other", max: 2 },
    });
    expect(parseRepoConfig("p", "retry:\n  max: 3\n").kind).toBe("invalid");
    expect(parseRepoConfig("p", "retry:\n  runners: other\n").kind).toBe("invalid");
  });

  test("reports YAML and schema errors", () => {
    expect(parseRepoConfig("p", "checks: [").kind).toBe("invalid");
    const unknown = parseRepoConfig("p", "chekcs: {}\n");
    expect(unknown.kind === "invalid" && unknown.error).toContain("chekcs");
    expect(parseRepoConfig("p", "checks:\n  pr-title: yes please\n").kind).toBe("invalid");
  });

  test("reads lint as a tool list or with paths, alongside pr-title", () => {
    const both = parseRepoConfig(
      "p",
      "checks:\n  pr-title: true\n  lint: [oxlint, oxfmt, oxlint]\n",
    );
    expect(both).toMatchObject({
      prTitle: { types: [] },
      lint: { tools: ["oxlint", "oxfmt"], paths: [] },
    });
    expect(
      parseRepoConfig("p", 'checks:\n  lint:\n    tools: [ruff]\n    paths: ["py/**"]\n'),
    ).toMatchObject({ prTitle: null, lint: { tools: ["ruff"], paths: ["py/**"] } });
  });

  test("rejects unknown lint tools and empty lists", () => {
    const unknown = parseRepoConfig("p", "checks:\n  lint: [eslint]\n");
    expect(unknown.kind === "invalid" && unknown.error).toContain("checks.lint");
    expect(parseRepoConfig("p", "checks:\n  lint: []\n").kind).toBe("invalid");
    expect(parseRepoConfig("p", "checks:\n  lint:\n    tool: [ruff]\n").kind).toBe("invalid");
  });
});
