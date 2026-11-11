// Lint check runs from the opt-in RelayRunner Checks App. A repo lists tools under `checks.lint`
// in relayrunner.yml (src/repo-config.ts). On each pull request push a LintRunner Durable Object
// (src/durable-objects/lint-runner.ts) opens one in-progress check run per tool, runs them all in
// one container (packages/lint-runner) and finishes the runs.

import type { WebhookMessage } from "@relayrunner/github-webhooks";
import type { LintResult, LintTool, Problem } from "@relayrunner/lint-runner/protocol";
import { containerRunnerAllowed } from "./container-runner.ts";
import type { Env } from "./env.ts";
import {
  appInstallationToken,
  appJwt,
  importAppPrivateKey,
  repoInstallationId,
  type CheckRunOutput,
  type PullRequestFile,
} from "./github-app.ts";
import type { CheckResult } from "./native-checks.ts";

// The commit to lint, and the pull request whose push asked for it, if any.
export interface LintWork {
  installationId: number;
  repo: string;
  headSha: string;
  pullRequest?: number;
}

// The pull request actions that bring a new head commit. A title edit doesn't change the code.
const NEW_CODE_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

/**
 * The commit a Checks App delivery asks to lint and the LintRunner to run it, or null. A pull
 * request push lints the new head, once per commit even when several pull requests share it.
 * "Re-run all checks" (check_suite rerequested) lints that suite's commit again, once per click.
 * GitHub also sends check_suite requested on every push, which the pull request event covers.
 */
export function lintTarget(message: WebhookMessage): { key: string; work: LintWork } | null {
  const { installationId } = message;
  if (!installationId) return null;
  let headSha: string;
  let pullRequest: number | undefined;
  let key: string;
  if (message.event === "pull_request" && NEW_CODE_ACTIONS.has(message.action ?? "")) {
    ({ headSha, number: pullRequest } = message.pullRequest);
    key = `${message.repository.fullName}@${headSha}`;
  } else if (message.event === "check_suite" && message.action === "rerequested") {
    headSha = message.checkSuite.headSha;
    pullRequest = message.checkSuite.pullRequests[0];
    key = `rerun:${message.deliveryId}`;
  } else return null;
  const work = { installationId, repo: message.repository.fullName, headSha, pullRequest };
  return { key, work };
}

export const lintCheckName = (tool: LintTool) => `Lint / ${tool}`;

/** An installation token for the Checks App, which has its own ID and key. */
export function checksAppToken(env: Env, installationId: number) {
  return appInstallationToken(
    {
      GITHUB_APP_ID: env.GITHUB_CHECKS_APP_ID,
      GITHUB_APP_PRIVATE_KEY: env.GITHUB_CHECKS_APP_PRIVATE_KEY,
    },
    installationId,
  );
}

/** The Checks App's installation on a repo, or null when it isn't installed there. */
export async function checksAppInstallationId(env: Env, repo: string) {
  const key = await importAppPrivateKey(await env.GITHUB_CHECKS_APP_PRIVATE_KEY.get());
  return repoInstallationId(await appJwt(env.GITHUB_CHECKS_APP_ID, key), repo);
}

/**
 * A native lint job's verdict from its tools' results: it fails when any tool failed or didn't
 * run, and names them. The check runs carry the details.
 */
export function lintJobResult(results: LintResult[] | { error: string }): CheckResult {
  if (!Array.isArray(results)) return { ok: false, reason: `Lint didn't run: ${results.error}` };
  const failed = results.filter(
    (result) => result.status === "failed" || result.status === "errored",
  );
  if (failed.length === 0) return { ok: true };
  const list = failed
    .map((result) =>
      result.status === "errored"
        ? `${result.tool} (didn't run)`
        : `${result.tool} (${plural(result.total.error, "error")})`,
    )
    .join(", ");
  return {
    ok: false,
    reason: `Lint failed: ${list}. The Lint check runs on this commit show each problem.`,
  };
}

/**
 * Hands a commit to its LintRunner, which reads the repo's config and does the rest. Skips an org
 * that may not start containers, since each one is billed to us.
 */
export async function startLintChecks(env: Env, target: { key: string; work: LintWork }) {
  const org = target.work.repo.split("/")[0];
  if (!containerRunnerAllowed(env.CONTAINER_RUNNER_ORGS, org)) return;
  await env.LINT_RUNNER.getByName(target.key).start(target.work);
}

/**
 * The lines a pull request adds or changes, per file path: their numbers in the new file, or "all"
 * when GitHub shows no patch for a changed file (binary, or too big to show).
 */
export type ChangedLines = Map<string, Set<number> | "all">;

export function changedLines(files: PullRequestFile[]): ChangedLines {
  const changed: ChangedLines = new Map();
  for (const file of files) {
    if (file.status === "removed") continue;
    if (file.patch === undefined) {
      if (file.changes > 0) changed.set(file.filename, "all");
      continue;
    }
    const lines = new Set<number>();
    let line = 0;
    for (const text of file.patch.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
      if (hunk) line = Number(hunk[1]);
      else if (text.startsWith("+")) lines.add(line++);
      else if (text.startsWith(" ")) line++;
      // "-" lines are gone from the new file, and "\ No newline at end of file" isn't a line.
    }
    changed.set(file.filename, lines);
  }
  return changed;
}

/**
 * Whether a problem was likely there before the pull request: it isn't on a line the pull request
 * added or changed. A hint, not a verdict: an edit can cause a problem on a line it didn't touch.
 * Linting the base commit too would tell for sure, at twice the cost.
 */
export function likelyPreExisting(problem: Problem, changed: ChangedLines) {
  const lines = changed.get(problem.path);
  if (!lines) return true;
  if (lines === "all") return false;
  for (let line = problem.line; line <= (problem.endLine ?? problem.line); line++)
    if (lines.has(line)) return false;
  return true;
}

// Where a result came from: the commit, for links to each problem's line, and on a pull request
// the lines it changed, to tell new problems from likely pre-existing ones.
export interface LintContext {
  repo: string;
  headSha: string;
  changed: ChangedLines | null;
}

// GitHub takes at most 50 annotations per check run update.
const MAX_ANNOTATIONS = 50;
// GitHub caps a check run summary at 65,535 characters; the findings lists stop well short.
const MAX_LIST_CHARS = 60_000;

/**
 * The finished check run for one tool's result: it fails on any error, and lists every problem
 * with a link to its line. On a pull request the problems off its changed lines are listed apart
 * as likely pre-existing, so a failure the PR didn't cause says so.
 */
export function lintCheckOutput(result: LintResult, context: LintContext): CheckRunOutput {
  if (result.status === "skipped")
    return {
      conclusion: "skipped",
      title: "Nothing to check",
      summary: `No files for ${result.tool} here.`,
    };
  if (result.status === "errored")
    return {
      conclusion: "failure",
      title: `${result.tool} didn't run`,
      summary: `${result.tool} exited with an error before reporting any problems. Its output:\n\n\`\`\`\n${result.output ?? ""}\n\`\`\``,
    };
  const conclusion = result.status === "failed" ? "failure" : "success";
  const counts = countsText(result.total);
  if (!counts)
    return { conclusion, title: "No problems", summary: `${result.tool} found no problems.` };
  const all = sum(result.total);
  const listed =
    all > result.problems.length ? ` Listing the first ${result.problems.length} of ${all}.` : "";
  const link = (problem: Problem, view = "blob") =>
    `https://github.com/${context.repo}/${view}/${context.headSha}/${problem.path}#L${problem.line}`;
  const { changed } = context;
  const fresh: Problem[] = [];
  const old: Problem[] = [];
  for (const problem of result.problems)
    (changed && likelyPreExisting(problem, changed) ? old : fresh).push(problem);
  const oldText = countsText(tally(old));
  let lead = `${result.tool} found ${counts}.`;
  let title = counts;
  if (!fresh.length && all === old.length) {
    lead = `${result.tool} found ${counts}, all on lines this pull request doesn't change, so they were likely already there.`;
    title = `${counts}, likely pre-existing`;
  } else if (old.length) {
    lead += ` ${oldText} ${old.length === 1 ? "is" : "are"} on lines this pull request doesn't change, so likely already there.`;
    title = `${counts} (${oldText} likely pre-existing)`;
  }
  const sections = [lead + listed];
  if (!old.length) sections.push(findingsList(fresh, link));
  else {
    if (fresh.length) sections.push(`### On changed lines\n\n${findingsList(fresh, link)}`);
    // A blame link per line, for when and where each one came in.
    sections.push(`### Likely pre-existing\n\n${findingsList(old, link, true)}`);
  }
  // Problems on changed lines first, as GitHub takes only the first 50.
  const annotations = [
    ...fresh.slice(0, MAX_ANNOTATIONS).map(annotation),
    ...old.slice(0, Math.max(0, MAX_ANNOTATIONS - fresh.length)).map((problem) => ({
      ...annotation(problem),
      title: `Likely pre-existing${problem.title ? `: ${problem.title}` : ""}`,
    })),
  ];
  return { conclusion, title, summary: sections.join("\n\n"), annotations };
}

// Problems grouped by file, each linking to its line, until the list would run past
// MAX_LIST_CHARS.
function findingsList(
  problems: Problem[],
  link: (problem: Problem, view?: string) => string,
  blame = false,
) {
  const byPath = Map.groupBy(problems, (problem) => problem.path);
  const lines: string[] = [];
  let length = 0;
  for (const [path, group] of byPath) {
    for (const [index, problem] of group.entries()) {
      const rule = problem.title ? ` \`${problem.title.replaceAll("`", "")}\`` : "";
      const line = `${index === 0 ? `\n**${escape(path)}**\n\n` : ""}- [Line ${problem.line}](${link(problem)}) ${problem.level}${rule}: ${escape(problem.message)}${blame ? ` ([blame](${link(problem, "blame")}))` : ""}`;
      if (length + line.length > MAX_LIST_CHARS) {
        // Each line so far is one problem.
        lines.push(`\n…and ${problems.length - lines.length} more.`);
        return lines.join("\n").trim();
      }
      lines.push(line);
      length += line.length + 1;
    }
  }
  return lines.join("\n").trim();
}

// One line of plain text: no line breaks, and no HTML for GitHub to render.
function escape(text: string) {
  return text.replaceAll(/\s+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").trim();
}

function tally(problems: Problem[]): LintResult["total"] {
  const total = { error: 0, warning: 0, notice: 0 };
  for (const problem of problems) total[problem.level]++;
  return total;
}

const sum = ({ error, warning, notice }: LintResult["total"]) => error + warning + notice;

function countsText({ error, warning, notice }: LintResult["total"]) {
  return [plural(error, "error"), plural(warning, "warning"), plural(notice, "notice")]
    .filter(Boolean)
    .join(", ");
}

/** The output for a check run whose tool never ran because the container failed. */
export function lintUnavailableOutput(reason: string): CheckRunOutput {
  return {
    conclusion: "neutral",
    title: "Lint didn't run",
    summary: `RelayRunner couldn't run lint for this commit: ${reason}`,
  };
}

function annotation(problem: Problem): NonNullable<CheckRunOutput["annotations"]>[number] {
  const endLine = problem.endLine ?? problem.line;
  return {
    path: problem.path,
    start_line: problem.line,
    end_line: endLine,
    // GitHub accepts columns only on a one-line annotation.
    ...(endLine === problem.line && problem.column
      ? { start_column: problem.column, end_column: problem.endColumn ?? problem.column }
      : {}),
    annotation_level: problem.level === "error" ? "failure" : problem.level,
    ...(problem.title ? { title: problem.title } : {}),
    message: problem.message,
  };
}

function plural(count: number, noun: string) {
  return count === 0 ? "" : `${count} ${noun}${count === 1 ? "" : "s"}`;
}
