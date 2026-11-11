import { DurableObject } from "cloudflare:workers";
import { LINT_PORT, type LintResult, type LintTool } from "@relayrunner/lint-runner/protocol";
import { containerRunnerAllowed } from "../container-runner.ts";
import { createDb } from "../db/index.ts";
import type { Env } from "../env.ts";
import { recordRepoCheck } from "../free-checks.ts";
import {
  completeCheckRun,
  GitHubAccessError,
  pullRequestFiles,
  repoTarball,
  startCheckRun,
  type CheckRunOutput,
} from "../github-app.ts";
import type { CheckResult } from "../native-checks.ts";
import {
  changedLines,
  checksAppInstallationId,
  checksAppToken,
  lintCheckName,
  lintCheckOutput,
  lintJobResult,
  lintUnavailableOutput,
  type ChangedLines,
  type LintWork,
} from "../lint-check.ts";
import { loadRepoConfig } from "../repo-config.ts";
import { errorMessage } from "../webhook-queue.ts";

// ½ vCPU, 4 GiB, like the container runners: the smallest size the durable_object scheduling
// policy offers that fits Node and the linters.
const INSTANCE = "standard-1";
// How long the container's server gets to come up.
const BOOT_TIMEOUT_MS = 60_000;
// Longer than the container gives all its tools together, so the container answers first.
const LINT_TIMEOUT_MS = 12 * 60_000;

// One per commit to lint (see lintTarget for the name), or per native lint job (`job:<id>`). Reads the repo's `checks.lint`, opens a
// check run per tool, boots the lint container without internet access, streams the commit's
// tarball into it, finishes each check run with its tool's result, and stops the container.
// Everything happens in the alarm, so a redelivered webhook never opens the runs twice.
export class LintRunner extends DurableObject<Env> {
  // Idempotent: a second start for the same commit does nothing.
  async start(work: LintWork): Promise<void> {
    if (await this.ctx.storage.get("started")) return;
    await this.ctx.storage.put({ started: true, work });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const work = await this.ctx.storage.get<LintWork>("work");
    if (!work) return;
    // One attempt: a failed run reports itself on the check runs instead of retrying.
    await this.ctx.storage.delete("work");
    const token = await checksAppToken(this.env, work.installationId);
    // Read alongside the config and the lint, since only the finished check runs need it.
    const changed = this.changed(work, token);
    const config = await loadRepoConfig(token, work.repo);
    // An invalid file fails the main App's PR title check with the reason; nothing to add here.
    if (config.kind !== "config" || !config.lint) return log("not configured", work, {});
    const results = await this.run(
      work,
      { checks: token },
      config.lint.tools,
      config.lint.paths,
      changed,
    );
    // For the Usage and Activity savings: a lint run that reported stands in for one Actions job.
    // A native `checks/lint` job is counted by its PickRunner instead, once per job. A failure here
    // only loses the count.
    if (Array.isArray(results))
      await recordRepoCheck(createDb(this.env.DB), work.repo, {
        check: "Lint",
        pullRequest: work.pullRequest ?? null,
        headSha: work.headSha,
        conclusion: lintJobResult(results).ok ? "success" : "failure",
        url: null,
      }).catch((error) =>
        log("error", work, { error: `saving not recorded: ${errorMessage(error)}` }),
      );
  }

  /**
   * For a native `checks/lint` workflow job (src/native-checks.ts): lints a commit now with the
   * job's own tools, whatever relayrunner.yml says, and returns the job's verdict.
   *
   * The commit is read with `jobToken`, the job's own GITHUB_TOKEN, so the repo needs no App that
   * can read its code. The token is used for that one download and never stored. Where the Checks
   * App is installed the check runs are posted as usual; elsewhere the problems come back as
   * annotations for the job.
   */
  async lintJob(
    target: { repo: string; headSha: string },
    tools: LintTool[],
    paths: string[],
    jobToken?: string,
  ): Promise<CheckResult> {
    // Each container is billed to us, like the webhook path in startLintChecks.
    if (!containerRunnerAllowed(this.env.CONTAINER_RUNNER_ORGS, target.repo.split("/")[0]))
      return { ok: false, reason: "RelayRunner doesn't run lint containers for this org yet." };
    const installationId = await checksAppInstallationId(this.env, target.repo).catch((error) => {
      if (!jobToken) throw error;
      return null;
    });
    if (!installationId && !jobToken)
      return {
        ok: false,
        reason: `Install the RelayRunner Checks App on ${target.repo} to run lint there.`,
      };
    const checks = installationId ? await checksAppToken(this.env, installationId) : undefined;
    const results = await this.run(
      { installationId: installationId ?? undefined, ...target },
      { checks, job: jobToken },
      tools,
      paths,
      Promise.resolve(null),
    );
    return lintJobResult(results, checks ? "checks" : "job");
  }

  // The lines a pull request changes, to mark the other problems as likely pre-existing. Without
  // them every problem reads as plain, which loses only the hint.
  private async changed(work: LintWork, token: string): Promise<ChangedLines | null> {
    if (!work.pullRequest) return null;
    try {
      const files = await pullRequestFiles(token, work.repo, work.pullRequest);
      return files && changedLines(files);
    } catch (error) {
      log("error", work, { error: `changed lines not read: ${errorMessage(error)}` });
      return null;
    }
  }

  // Lints in the container and stops it. With the Checks App's token it opens a check run per
  // tool and finishes them. The commit is read with a job's own token when there is one.
  private async run(
    work: LintTarget,
    tokens: { checks?: string; job?: string },
    tools: LintTool[],
    paths: string[],
    changed: Promise<ChangedLines | null>,
  ): Promise<LintResult[] | { error: string }> {
    const startedAt = Date.now();
    const token = tokens.checks;
    const codeToken = tokens.job ?? token;
    if (!codeToken) return { error: "no token to read the commit with" };
    const checkRuns = new Map(
      token
        ? await Promise.all(
            tools.map(
              async (tool) =>
                [
                  tool,
                  await startCheckRun(token, work.repo, lintCheckName(tool), work.headSha),
                ] as const,
            ),
          )
        : [],
    );
    const finish = (output: (tool: LintTool) => CheckRunOutput) =>
      Promise.all(
        [...checkRuns].map(([tool, id]) =>
          completeCheckRun(token!, work.repo, id, output(tool)).catch((error) =>
            log("error", work, { tool, error: `check run not finished: ${errorMessage(error)}` }),
          ),
        ),
      );
    let results: LintResult[];
    try {
      results = await this.lint(work, codeToken, tools, paths);
    } catch (error) {
      // GitHub refuses, or answers 404 for a private repo, when the job's token can't read code.
      const hint =
        tokens.job && error instanceof GitHubAccessError
          ? ". Give the job `permissions: contents: read`."
          : "";
      const reason = errorMessage(error) + hint;
      log("error", work, { error: reason, durationMs: Date.now() - startedAt });
      await finish(() => lintUnavailableOutput(reason));
      return { error: reason };
    } finally {
      await this.ctx.container?.destroy().catch(() => undefined);
    }
    const byTool = new Map(results.map((result) => [result.tool, result]));
    const context = { repo: work.repo, headSha: work.headSha, changed: await changed };
    await finish((tool) => {
      const result = byTool.get(tool);
      return result
        ? lintCheckOutput(result, context)
        : lintUnavailableOutput("the container skipped it");
    });
    log("finished", work, { durationMs: Date.now() - startedAt, ...resultsLog(results) });
    return results;
  }

  private async lint(
    work: LintTarget,
    token: string,
    tools: LintTool[],
    paths: string[],
  ): Promise<LintResult[]> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container is configured");
    if (!container.running)
      container.start({ image: container.images.lint, instance: INSTANCE, enableInternet: false });
    const port = container.getTcpPort(LINT_PORT);
    // GitHub's redirect and first bytes overlap with the container's boot.
    const [tarball] = await Promise.all([
      repoTarball(token, work.repo, work.headSha),
      waitForHealth(port),
    ]);
    const query = new URLSearchParams({ tools: tools.join(",") });
    for (const path of paths) query.append("path", path);
    const response = await port.fetch(`http://lint/lint?${query}`, {
      method: "POST",
      body: tarball,
      signal: AbortSignal.timeout(LINT_TIMEOUT_MS),
    });
    const body = (await response.json()) as { results?: LintResult[]; error?: string };
    if (!response.ok || !body.results)
      throw new Error(body.error ?? `the container answered ${response.status}`);
    return body.results;
  }
}

async function waitForHealth(port: Fetcher) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      if ((await port.fetch("http://lint/health")).ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("the lint container didn't start");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// A commit to lint. A native job without the Checks App has no installation.
type LintTarget = Pick<LintWork, "repo" | "headSha"> & { installationId?: number };

const resultsLog = (results: LintResult[]) => ({
  results: results.map(({ tool, status, total, durationMs }) => ({
    tool,
    status,
    total,
    durationMs,
  })),
});

function log(event: string, work: LintTarget, fields: Record<string, unknown>) {
  (event === "error" ? console.error : console.log)(
    JSON.stringify({
      msg: `lint runner ${event}`,
      repo: work.repo,
      headSha: work.headSha,
      installationId: work.installationId,
      ...fields,
    }),
  );
}
