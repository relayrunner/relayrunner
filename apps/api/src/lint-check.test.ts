import { describe, expect, test } from "vitest";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import type { LintResult } from "@relayrunner/lint-runner/protocol";
import {
  changedLines,
  likelyPreExisting,
  lintCheckOutput,
  lintJobResult,
  lintTarget,
  type LintContext,
} from "./lint-check.ts";

const base = { deliveryId: "d", installationId: 7, receivedAt: "t", app: "checks" as const };
const repository = { id: 1, fullName: "acme/app" };

function pullRequest(action: string): WebhookMessage {
  return {
    ...base,
    action,
    event: "pull_request",
    repository,
    pullRequest: { number: 3, title: "feat: x", headSha: "abc" },
  };
}

function checkSuite(action: string): WebhookMessage {
  return {
    ...base,
    action,
    event: "check_suite",
    repository,
    checkSuite: { id: 9, headSha: "def", headBranch: "main", pullRequests: [3] },
  };
}

describe("lintTarget", () => {
  test("lints each pull request head once, and each re-run click", () => {
    const work = { installationId: 7, repo: "acme/app" };
    expect(lintTarget(pullRequest("opened"))).toEqual({
      key: "acme/app@abc",
      work: { ...work, headSha: "abc", pullRequest: 3 },
    });
    expect(lintTarget(pullRequest("synchronize"))?.key).toBe("acme/app@abc");
    expect(lintTarget(checkSuite("rerequested"))).toEqual({
      key: "rerun:d",
      work: { ...work, headSha: "def", pullRequest: 3 },
    });
  });

  test("skips title edits, the push-time suite, and deliveries without an installation", () => {
    expect(lintTarget(pullRequest("edited"))).toBeNull();
    expect(lintTarget(checkSuite("requested"))).toBeNull();
    expect(lintTarget({ ...pullRequest("opened"), installationId: null })).toBeNull();
  });
});

describe("lintCheckOutput", () => {
  const commit: LintContext = { repo: "acme/app", headSha: "abc", changed: null };
  const result = (overrides: Partial<LintResult>): LintResult => ({
    tool: "oxlint",
    status: "passed",
    problems: [],
    total: { error: 0, warning: 0, notice: 0 },
    durationMs: 10,
    ...overrides,
  });

  test("passes a clean run", () => {
    expect(lintCheckOutput(result({}), commit)).toEqual({
      conclusion: "success",
      title: "No problems",
      summary: "oxlint found no problems.",
    });
  });

  test("fails on errors and annotates them, with columns only on one line", () => {
    const output = lintCheckOutput(
      result({
        status: "failed",
        total: { error: 1, warning: 1, notice: 0 },
        problems: [
          {
            path: "a.js",
            line: 2,
            column: 1,
            endColumn: 9,
            level: "error",
            title: "no-debugger",
            message: "m",
          },
          { path: "b.js", line: 3, endLine: 5, column: 4, level: "warning", message: "w" },
        ],
      }),
      commit,
    );
    expect(output.conclusion).toBe("failure");
    expect(output.title).toBe("1 error, 1 warning");
    expect(output.summary).toBe(
      [
        "oxlint found 1 error, 1 warning.",
        "",
        "**a.js**",
        "",
        "- [Line 2](https://github.com/acme/app/blob/abc/a.js#L2) error `no-debugger`: m",
        "",
        "**b.js**",
        "",
        "- [Line 3](https://github.com/acme/app/blob/abc/b.js#L3) warning: w",
      ].join("\n"),
    );
    expect(output.annotations).toEqual([
      {
        path: "a.js",
        start_line: 2,
        end_line: 2,
        start_column: 1,
        end_column: 9,
        annotation_level: "failure",
        title: "no-debugger",
        message: "m",
      },
      { path: "b.js", start_line: 3, end_line: 5, annotation_level: "warning", message: "w" },
    ]);
  });

  test("annotates the first 50 and says how many the container left out", () => {
    const problems = Array.from({ length: 60 }, (_, i) => ({
      path: "a.py",
      line: i + 1,
      level: "error" as const,
      message: "x",
    }));
    const output = lintCheckOutput(
      result({
        tool: "ruff",
        status: "failed",
        problems,
        total: { error: 70, warning: 0, notice: 0 },
      }),
      commit,
    );
    expect(output.annotations).toHaveLength(50);
    expect(output.summary).toContain("Listing the first 60 of 70.");
    expect(output.summary).toContain("#L60) error: x");
  });

  test("fails a tool that errored with its output, and skips one with nothing to check", () => {
    const errored = lintCheckOutput(result({ status: "errored", output: "bad config" }), commit);
    expect(errored).toMatchObject({ conclusion: "failure", title: "oxlint didn't run" });
    expect(errored.summary).toContain("bad config");
    expect(
      lintCheckOutput(result({ tool: "actionlint", status: "skipped" }), commit).conclusion,
    ).toBe("skipped");
  });

  test("still fails on a pull request, but marks problems off its changed lines", () => {
    const pr = { ...commit, changed: new Map([["a.yml", new Set([13])]]) };
    const problems = [
      { path: "a.yml", line: 13, level: "error" as const, title: "unpinned-uses", message: "u" },
      { path: "a.yml", line: 20, level: "error" as const, title: "unpinned-uses", message: "u" },
      { path: "b.yml", line: 1, level: "warning" as const, message: "w" },
    ];
    const failed = result({
      tool: "zizmor",
      status: "failed",
      problems,
      total: { error: 2, warning: 1, notice: 0 },
    });
    const output = lintCheckOutput(failed, pr);
    expect(output.conclusion).toBe("failure");
    expect(output.title).toBe("2 errors, 1 warning (1 error, 1 warning likely pre-existing)");
    expect(output.summary).toContain(
      "zizmor found 2 errors, 1 warning. 1 error, 1 warning are on lines this pull request doesn't change, so likely already there.",
    );
    expect(output.summary).toMatch(/### On changed lines\n\n\*\*a\.yml\*\*\n\n- \[Line 13\]/);
    expect(output.summary).toMatch(/### Likely pre-existing\n\n\*\*a\.yml\*\*\n\n- \[Line 20\]/);
    expect(output.annotations?.map((annotation) => annotation.title)).toEqual([
      "unpinned-uses",
      "Likely pre-existing: unpinned-uses",
      "Likely pre-existing",
    ]);

    const untouched = lintCheckOutput(failed, { ...pr, changed: new Map() });
    expect(untouched.conclusion).toBe("failure");
    expect(untouched.title).toBe("2 errors, 1 warning, likely pre-existing");
    expect(untouched.summary).not.toContain("On changed lines");
  });
});

describe("changedLines", () => {
  test("reads the new file's added lines from each patch", () => {
    const changed = changedLines([
      {
        filename: "a.ts",
        status: "modified",
        changes: 3,
        patch:
          "@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+added\n keep\n@@ -10 +11 @@\n-x\n+y\n\\ No newline at end of file",
      },
      { filename: "big.bin", status: "modified", changes: 2 },
      { filename: "moved.ts", status: "renamed", changes: 0 },
      { filename: "gone.ts", status: "removed", changes: 4, patch: "@@ -1 +0,0 @@\n-x" },
    ]);
    expect(changed).toEqual(
      new Map<string, Set<number> | "all">([
        ["a.ts", new Set([2, 3, 11])],
        ["big.bin", "all"],
      ]),
    );
    const problem = (path: string, line: number, endLine?: number) => ({
      path,
      line,
      endLine,
      level: "error" as const,
      message: "m",
    });
    expect(likelyPreExisting(problem("a.ts", 2), changed)).toBe(false);
    expect(likelyPreExisting(problem("a.ts", 1, 2), changed)).toBe(false);
    expect(likelyPreExisting(problem("a.ts", 4), changed)).toBe(true);
    expect(likelyPreExisting(problem("big.bin", 9), changed)).toBe(false);
    expect(likelyPreExisting(problem("moved.ts", 1), changed)).toBe(true);
  });
});

describe("lintJobResult", () => {
  const result = (
    tool: LintResult["tool"],
    status: LintResult["status"],
    error = 0,
  ): LintResult => ({
    tool,
    status,
    problems: [],
    total: { error, warning: 0, notice: 0 },
    durationMs: 1,
  });

  test("passes when every tool passed or had nothing to check", () => {
    expect(lintJobResult([result("oxlint", "passed"), result("ruff", "skipped")])).toEqual({
      ok: true,
    });
  });

  test("names the tools that failed or didn't run", () => {
    expect(
      lintJobResult([
        result("oxlint", "passed"),
        result("typos", "failed", 2),
        result("zizmor", "errored"),
      ]),
    ).toEqual({
      ok: false,
      reason:
        "Lint failed: typos (2 errors), zizmor (didn't run). The Lint check runs on this commit show each problem.",
    });
  });

  test("fails when the container didn't run", () => {
    expect(lintJobResult({ error: "boom" })).toEqual({
      ok: false,
      reason: "Lint didn't run: boom",
    });
  });
});
