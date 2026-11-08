import { describe, expect, test } from "vitest";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import type { LintResult } from "@relayrunner/lint-runner/protocol";
import { lintCheckOutput, lintJobResult, lintTarget } from "./lint-check.ts";

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
      work: { ...work, headSha: "abc" },
    });
    expect(lintTarget(pullRequest("synchronize"))?.key).toBe("acme/app@abc");
    expect(lintTarget(checkSuite("rerequested"))).toEqual({
      key: "rerun:d",
      work: { ...work, headSha: "def" },
    });
  });

  test("skips title edits, the push-time suite, and deliveries without an installation", () => {
    expect(lintTarget(pullRequest("edited"))).toBeNull();
    expect(lintTarget(checkSuite("requested"))).toBeNull();
    expect(lintTarget({ ...pullRequest("opened"), installationId: null })).toBeNull();
  });
});

describe("lintCheckOutput", () => {
  const result = (overrides: Partial<LintResult>): LintResult => ({
    tool: "oxlint",
    status: "passed",
    problems: [],
    total: { error: 0, warning: 0, notice: 0 },
    durationMs: 10,
    ...overrides,
  });

  test("passes a clean run", () => {
    expect(lintCheckOutput(result({}))).toEqual({
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
    );
    expect(output.conclusion).toBe("failure");
    expect(output.title).toBe("1 error, 1 warning");
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

  test("says how many problems there were beyond the 50 the container sends", () => {
    const problems = Array.from({ length: 50 }, (_, i) => ({
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
        total: { error: 60, warning: 0, notice: 0 },
      }),
    );
    expect(output.annotations).toHaveLength(50);
    expect(output.summary).toContain("Showing the first 50 of 60.");
  });

  test("fails a tool that errored with its output, and skips one with nothing to check", () => {
    const errored = lintCheckOutput(result({ status: "errored", output: "bad config" }));
    expect(errored).toMatchObject({ conclusion: "failure", title: "oxlint didn't run" });
    expect(errored.summary).toContain("bad config");
    expect(lintCheckOutput(result({ tool: "actionlint", status: "skipped" })).conclusion).toBe(
      "skipped",
    );
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
