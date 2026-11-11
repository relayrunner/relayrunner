// What the API's LintRunner Durable Object and the lint container (src/server.ts) say to each
// other. The Durable Object POSTs the repo's tarball to /lint with the tools and paths in the
// query string, and the container answers with one LintResult per tool.

export const LINT_PORT = 8080;

// The tools the container can run. relayrunner.yml's `checks.lint` accepts exactly these.
export const LINT_TOOLS = [
  "oxlint",
  "oxfmt",
  "ruff",
  "actionlint",
  "zizmor",
  "shellcheck",
  "typos",
] as const;
export type LintTool = (typeof LINT_TOOLS)[number];

export type ProblemLevel = "error" | "warning" | "notice";

export interface Problem {
  // Relative to the repo root.
  path: string;
  line: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
  level: ProblemLevel;
  // The rule, like "eslint(no-debugger)" or "ruff (F401)".
  title?: string;
  message: string;
}

export interface LintResult {
  tool: LintTool;
  // passed: no errors (warnings allowed). failed: at least one error. skipped: nothing for the
  // tool to check (no workflows, no shell scripts). errored: the tool exited non-zero without
  // reporting a problem, usually a bad config; `output` says why.
  status: "passed" | "failed" | "skipped" | "errored";
  // Problems inside the configured paths, errors first, at most MAX_PROBLEMS of them.
  problems: Problem[];
  // Every problem inside the configured paths, including the ones cut from `problems`.
  total: { error: number; warning: number; notice: number };
  durationMs: number;
  // The end of the tool's output, for a result that errored.
  output?: string;
}

// How many problems the container reports per tool; `total` counts the rest.
export const MAX_PROBLEMS = 1000;
