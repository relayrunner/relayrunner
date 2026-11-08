import { DurableObject } from "cloudflare:workers";
import { LINT_PORT, type LintResult, type LintTool } from "@relayrunner/lint-runner/protocol";
import type { Env } from "../env.ts";
import {
  completeCheckRun,
  repoTarball,
  startCheckRun,
  type CheckRunOutput,
} from "../github-app.ts";
import {
  checksAppToken,
  lintCheckName,
  lintCheckOutput,
  lintUnavailableOutput,
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

// One per commit to lint (see lintTarget for the name). Reads the repo's `checks.lint`, opens a
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
    const startedAt = Date.now();
    const token = await checksAppToken(this.env, work.installationId);
    const config = await loadRepoConfig(token, work.repo);
    // An invalid file fails the main App's PR title check with the reason; nothing to add here.
    if (config.kind !== "config" || !config.lint) return log("not configured", work, {});
    const { tools, paths } = config.lint;
    const checkRuns = new Map(
      await Promise.all(
        tools.map(
          async (tool) =>
            [
              tool,
              await startCheckRun(token, work.repo, lintCheckName(tool), work.headSha),
            ] as const,
        ),
      ),
    );
    const finish = (output: (tool: LintTool) => CheckRunOutput) =>
      Promise.all(
        [...checkRuns].map(([tool, id]) =>
          completeCheckRun(token, work.repo, id, output(tool)).catch((error) =>
            log("error", work, { tool, error: `check run not finished: ${errorMessage(error)}` }),
          ),
        ),
      );
    let results: LintResult[];
    try {
      results = await this.lint(work, token, tools, paths);
    } catch (error) {
      const reason = errorMessage(error);
      log("error", work, { error: reason, durationMs: Date.now() - startedAt });
      await finish(() => lintUnavailableOutput(reason));
      return;
    } finally {
      await this.ctx.container?.destroy().catch(() => undefined);
    }
    const byTool = new Map(results.map((result) => [result.tool, result]));
    await finish((tool) => {
      const result = byTool.get(tool);
      return result ? lintCheckOutput(result) : lintUnavailableOutput("the container skipped it");
    });
    log("finished", work, {
      durationMs: Date.now() - startedAt,
      results: results.map(({ tool, status, total, durationMs }) => ({
        tool,
        status,
        total,
        durationMs,
      })),
    });
  }

  private async lint(
    work: LintWork,
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

function log(event: string, work: LintWork, fields: Record<string, unknown>) {
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
