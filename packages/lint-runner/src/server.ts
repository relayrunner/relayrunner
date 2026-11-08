// The lint container's server (Dockerfile). The API's LintRunner Durable Object starts the
// container without internet access, POSTs the repo's tarball to /lint, and gets one LintResult
// per tool back. Tools run one at a time: the container has half a vCPU.
//
// Node runs this file as TypeScript directly (type stripping), so it uses no TS-only syntax.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGccLines, parseOxfmtCheck, parseWorkflowCommands, pathMatcher } from "./parse.ts";
import {
  LINT_PORT,
  LINT_TOOLS,
  MAX_PROBLEMS,
  type LintResult,
  type LintTool,
  type Problem,
} from "./protocol.ts";

// A tool still running after this is stopped and reported as errored.
const TOOL_TIMEOUT_MS = 5 * 60_000;
// How much of an errored tool's output goes back.
const OUTPUT_TAIL = 4000;
// Directories no tool should walk into.
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", ".venv"]);

interface Tool {
  // Files or directories to run on, or null when there's nothing for the tool to check.
  targets?(root: string): Promise<string[] | null>;
  command(targets: string[]): [string, string[]];
  parse(output: string, root: string): Problem[];
}

// One workflow command per error. The newline is a real one: actionlint rejects `{{"\\n"}}`.
const ACTIONLINT_FORMAT =
  "{{range $err := .}}::error file={{$err.Filepath}},line={{$err.Line}},col={{$err.Column}},title=actionlint ({{$err.Kind}})::{{$err.Message}}\n{{end}}";

const TOOLS: Record<LintTool, Tool> = {
  oxlint: { command: () => ["oxlint", ["--format=github"]], parse: parseWorkflowCommands },
  oxfmt: { command: () => ["oxfmt", ["--check"]], parse: parseOxfmtCheck },
  ruff: {
    command: () => ["ruff", ["check", "--output-format=github"]],
    parse: parseWorkflowCommands,
  },
  // Given the files: without a .git directory (a tarball has none) it can't find the workflows.
  actionlint: {
    targets: workflowFiles,
    command: (files) => ["actionlint", ["-format", ACTIONLINT_FORMAT, ...files]],
    parse: parseWorkflowCommands,
  },
  zizmor: {
    targets: workflowFiles,
    command: (files) => ["zizmor", ["--offline", "--no-progress", "--format=github", ...files]],
    parse: parseWorkflowCommands,
  },
  shellcheck: {
    targets: (root) => findFiles(root, /\.(?:sh|bash)$/),
    command: (files) => ["shellcheck", ["--format=gcc", ...files]],
    parse: parseGccLines,
  },
  typos: { command: () => ["typos", ["--format=brief"]], parse: parseGccLines },
};

export async function lint(
  root: string,
  tools: LintTool[],
  paths: string[],
): Promise<LintResult[]> {
  const inScope = pathMatcher(paths);
  const results: LintResult[] = [];
  for (const name of tools) {
    const tool = TOOLS[name];
    const started = Date.now();
    const targets = tool.targets ? await tool.targets(root) : [];
    if (!targets) {
      results.push(result(name, "skipped", [], started));
      continue;
    }
    const [command, args] = tool.command(targets);
    const run = await exec(command, args, root);
    const found = tool.parse(run.output, root);
    const problems = found.filter((problem) => inScope(problem.path));
    const status =
      run.code !== 0 && found.length === 0
        ? "errored"
        : problems.some((problem) => problem.level === "error")
          ? "failed"
          : "passed";
    results.push(
      result(
        name,
        status,
        problems,
        started,
        status === "errored" ? run.output.slice(-OUTPUT_TAIL) : undefined,
      ),
    );
  }
  return results;
}

function result(
  tool: LintTool,
  status: LintResult["status"],
  problems: Problem[],
  started: number,
  output?: string,
): LintResult {
  const total = { error: 0, warning: 0, notice: 0 };
  for (const problem of problems) total[problem.level]++;
  const rank = { error: 0, warning: 1, notice: 2 };
  return {
    tool,
    status,
    problems: problems.toSorted((a, b) => rank[a.level] - rank[b.level]).slice(0, MAX_PROBLEMS),
    total,
    durationMs: Date.now() - started,
    output,
  };
}

function workflowFiles(root: string) {
  return findFiles(join(root, ".github", "workflows"), /\.ya?ml$/, ".github/workflows");
}

// Files under `dir` whose names match, as paths starting with `prefix`; null when there are none.
async function findFiles(dir: string, pattern: RegExp, prefix = "") {
  const files: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), path);
      } else if (entry.isFile() && pattern.test(entry.name)) files.push(path);
    }
  };
  if (!(await stat(dir).catch(() => null))?.isDirectory()) return null;
  await walk(dir, prefix);
  return files.length > 0 ? files : null;
}

// Runs a command in the repo and returns its exit code and combined output. A missing binary or
// a timeout reads as exit code -1.
function exec(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(command, args, { cwd, timeout: TOOL_TIMEOUT_MS });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

// Unpacks a GitHub tarball (one top-level `owner-repo-sha/` directory) into `dir`.
function extract(body: IncomingMessage, dir: string) {
  return new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-xz", "--strip-components=1", "-C", dir]);
    let stderr = "";
    tar.stderr.on("data", (chunk) => (stderr += chunk));
    tar.on("error", reject);
    tar.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar failed: ${stderr}`)),
    );
    body.pipe(tar.stdin);
  });
}

function parseTools(value: string | null): LintTool[] | null {
  const tools = (value ?? "").split(",").filter(Boolean);
  return tools.length > 0 && tools.every((tool) => (LINT_TOOLS as readonly string[]).includes(tool))
    ? (tools as LintTool[])
    : null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://lint");
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return reply(200, { ok: true });
  if (url.pathname !== "/lint" || request.method !== "POST")
    return reply(404, { error: "not_found" });
  const tools = parseTools(url.searchParams.get("tools"));
  if (!tools) return reply(400, { error: "unknown_tools" });
  const paths = url.searchParams.getAll("path");
  const dir = await mkdtemp(join(tmpdir(), "repo-"));
  try {
    await extract(request, dir);
    reply(200, { results: await lint(dir, tools, paths) });
  } catch (error) {
    reply(500, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

if (import.meta.main) server.listen(LINT_PORT, () => console.log(`lint server on :${LINT_PORT}`));
