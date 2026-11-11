import { describe, expect, test } from "vitest";
import { parseGccLines, parseOxfmtCheck, parseWorkflowCommands, pathMatcher } from "./parse.ts";

// Real output from each tool.
describe("parseWorkflowCommands", () => {
  test("reads oxlint, with the repeated location stripped", () => {
    const output = [
      "::warning file=src/a.js,line=2,endLine=2,col=1,endColumn=10,title=eslint(no-debugger)::src/a.js:2:1: `debugger` statement is not allowed",
      "",
      "Found 1 warning and 0 errors.",
    ].join("\n");
    expect(parseWorkflowCommands(output, "/repo")).toEqual([
      {
        path: "src/a.js",
        line: 2,
        endLine: 2,
        column: 1,
        endColumn: 10,
        level: "warning",
        title: "eslint(no-debugger)",
        message: "`debugger` statement is not allowed",
      },
    ]);
  });

  test("makes ruff's absolute paths relative and unescapes its message", () => {
    const output =
      "::error title=ruff (F401),file=/tmp/repo-x/b.py,line=1,col=8,endLine=1,endColumn=10::b.py:1:8: F401 `os` imported but unused%0A  help: Remove unused import: `os`";
    expect(parseWorkflowCommands(output, "/tmp/repo-x")).toEqual([
      expect.objectContaining({
        path: "b.py",
        level: "error",
        title: "ruff (F401)",
        message: "`os` imported but unused\n  help: Remove unused import: `os`",
      }),
    ]);
  });

  test("reads zizmor's lines without columns and ignores its log lines", () => {
    const output = [
      " INFO zizmor: 🌈 zizmor v1.32.0",
      "::error file=.github/workflows/ci.yml,line=7,title=template-injection::ci.yml:7: code injection via template expansion",
    ].join("\n");
    expect(parseWorkflowCommands(output, "/repo")).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 7,
        endLine: undefined,
        column: undefined,
        endColumn: undefined,
        level: "error",
        title: "template-injection",
        message: "code injection via template expansion",
      },
    ]);
  });
});

describe("parseGccLines", () => {
  test("reads shellcheck, with warnings as errors and info as notices", () => {
    const output = [
      "run.sh:2:6: note: Double quote to prevent globbing and word splitting. [SC2086]",
      "run.sh:3:1: warning: foo appears unused. [SC2034]",
    ].join("\n");
    expect(parseGccLines(output, "/repo")).toEqual([
      expect.objectContaining({
        path: "run.sh",
        line: 2,
        column: 6,
        level: "notice",
        title: "SC2086",
      }),
      expect.objectContaining({ level: "error", message: "foo appears unused." }),
    ]);
  });

  test("reads typos' brief format", () => {
    expect(parseGccLines("./notes.md:1:1: error: `teh` should be `the`", "/repo")).toEqual([
      {
        path: "notes.md",
        line: 1,
        column: 1,
        level: "error",
        title: undefined,
        message: "`teh` should be `the`",
      },
    ]);
  });
});

test("parseOxfmtCheck lists each unformatted file", () => {
  const output = [
    "Checking formatting...",
    "",
    "src/a.js (0ms)",
    "src/deep/b.ts (12ms)",
    "",
    "Format issues found in above 2 files. Run without `--check` to fix.",
    "Finished in 2ms on 3 files using 4 threads.",
  ].join("\n");
  expect(parseOxfmtCheck(output).map((problem) => problem.path)).toEqual([
    "src/a.js",
    "src/deep/b.ts",
  ]);
});

test("pathMatcher", () => {
  expect(pathMatcher([])("anything/at/all.ts")).toBe(true);
  const match = pathMatcher(["apps/**/*.ts", "scripts", "*.md"]);
  expect(match("apps/api/src/x.ts")).toBe(true);
  expect(match("apps/x.ts")).toBe(true);
  expect(match("apps/x.js")).toBe(false);
  expect(match("scripts/deploy.sh")).toBe(true);
  expect(match("README.md")).toBe(true);
  expect(match("docs/README.md")).toBe(false);
});
