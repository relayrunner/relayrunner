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

/** The finished check run for one tool's result. */
export function lintCheckOutput(result: LintResult): CheckRunOutput {
  const { error, warning, notice } = result.total;
  const counts = [plural(error, "error"), plural(warning, "warning"), plural(notice, "notice")]
    .filter(Boolean)
    .join(", ");
  const annotations = result.problems.map(annotation);
  const all = error + warning + notice;
  const more =
    all > annotations.length ? `\n\nShowing the first ${annotations.length} of ${all}.` : "";
  switch (result.status) {
    case "skipped":
      return {
        conclusion: "skipped",
        title: "Nothing to check",
        summary: `No files for ${result.tool} here.`,
      };
    case "errored":
      return {
        conclusion: "failure",
        title: `${result.tool} didn't run`,
        summary: `${result.tool} exited with an error before reporting any problems. Its output:\n\n\`\`\`\n${result.output ?? ""}\n\`\`\``,
      };
    case "failed":
      return {
        conclusion: "failure",
        title: counts,
        summary: `${result.tool} found ${counts}.${more}`,
        annotations,
      };
    case "passed":
      return {
        conclusion: "success",
        title: all ? counts : "No problems",
        summary: all
          ? `${result.tool} found ${counts}, and no errors.${more}`
          : `${result.tool} found no problems.`,
        ...(all ? { annotations } : {}),
      };
  }
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
