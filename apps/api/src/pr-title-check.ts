// The "PR title" check: the GitHub App posts a check run on each pull request saying whether its
// title is a Conventional Commit. No runner and no workflow, so it works on public repos and costs
// no Actions minute. A repo turns it on with `checks: pr-title` in relayrunner.yml
// (src/repo-config.ts).

import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { postFreeCheck } from "./free-checks.ts";
import { appInstallationToken } from "./github-app.ts";
import { checkConventionalTitle } from "./native-checks.ts";
import { loadRepoConfig, type ConfigResult } from "./repo-config.ts";

export const PR_TITLE_CHECK_NAME = "PR title";

type PullRequestMessage = Extract<WebhookMessage, { event: "pull_request" }>;

/**
 * The check run for a title under the repo's config, or null when the repo hasn't turned the
 * check on. A relayrunner.yml that doesn't parse fails the check with the reason, since the repo
 * meant to configure something.
 */
export function prTitleCheckRun(config: ConfigResult, title: string, headSha: string) {
  if (config.kind === "none") return null;
  if (config.kind === "invalid")
    return {
      name: PR_TITLE_CHECK_NAME,
      headSha,
      conclusion: "failure" as const,
      title: `${config.path} is invalid`,
      summary: `RelayRunner couldn't read ${config.path} on the default branch: ${config.error}`,
    };
  const { prTitle } = config;
  if (!prTitle) return null;
  const result = checkConventionalTitle(title, prTitle.types);
  return {
    name: PR_TITLE_CHECK_NAME,
    headSha,
    conclusion: result.ok ? ("success" as const) : ("failure" as const),
    title: result.ok ? "Conventional Commit title" : "Not a Conventional Commit title",
    summary: result.ok ? `"${title}" is a Conventional Commit.` : result.reason,
  };
}

/** Posts the check run for a pull request that opened, changed its title or got new commits. */
export async function checkPullRequestTitle(env: Env, message: PullRequestMessage) {
  if (!message.installationId) return;
  const repo = message.repository.fullName;
  const token = await appInstallationToken(env, message.installationId);
  const config = await loadRepoConfig(token, repo);
  const check = prTitleCheckRun(config, message.pullRequest.title, message.pullRequest.headSha);
  if (check)
    await postFreeCheck(
      createDb(env.DB),
      token,
      message.installationId,
      {
        repository: message.repository,
        number: message.pullRequest.number,
      },
      check,
    );
  console.log(
    JSON.stringify({
      msg: "relayrunner pr title checked",
      deliveryId: message.deliveryId,
      repository: repo,
      pullRequest: message.pullRequest.number,
      config: config.kind === "none" ? null : config.path,
      conclusion: check?.conclusion ?? "off",
    }),
  );
}
