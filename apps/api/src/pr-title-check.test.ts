import { describe, expect, test } from "vitest";
import { prTitleCheckRun } from "./pr-title-check.ts";
import { parseRepoConfig } from "./repo-config.ts";

const on = parseRepoConfig("relayrunner.yml", "checks:\n  pr-title: true\n");

describe("prTitleCheckRun", () => {
  test("posts nothing without a config or with the check off", () => {
    expect(prTitleCheckRun({ kind: "none" }, "Add checks", "abc")).toBeNull();
    const off = parseRepoConfig("relayrunner.yml", "checks:\n  pr-title: false\n");
    expect(prTitleCheckRun(off, "Add checks", "abc")).toBeNull();
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
    const docs = parseRepoConfig(
      ".github/relayrunner.yml",
      "checks:\n  pr-title:\n    types: [docs]\n",
    );
    expect(prTitleCheckRun(docs, "docs: x", "abc")?.conclusion).toBe("success");
    expect(prTitleCheckRun(docs, "feat: x", "abc")?.conclusion).toBe("failure");
  });

  test("fails with the reason when the config is invalid", () => {
    const bad = parseRepoConfig("relayrunner.yml", "checks:\n  pr-titel: true\n");
    expect(prTitleCheckRun(bad, "feat: x", "abc")).toMatchObject({
      conclusion: "failure",
      title: "relayrunner.yml is invalid",
    });
  });
});

describe("parseRepoConfig", () => {
  test("reads pr-title as on, off, or with types", () => {
    expect(on).toEqual({
      kind: "config",
      path: "relayrunner.yml",
      prTitle: { types: [] },
      lint: null,
    });
    expect(parseRepoConfig("p", "")).toEqual({
      kind: "config",
      path: "p",
      prTitle: null,
      lint: null,
    });
    expect(parseRepoConfig("p", "checks:\n  pr-title:\n    types: feat, fix\n")).toEqual({
      kind: "config",
      path: "p",
      prTitle: { types: ["feat", "fix"] },
      lint: null,
    });
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
