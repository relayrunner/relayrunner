// Pull request checks the main GitHub App posts as check runs from the pull_request webhook alone:
// "PR title" (a Conventional Commit title) and "PR description" (the PR says what it changes). No
// runner, no workflow and no code read, so they work on public repos, cost no Actions minute and
// are open to every repo. A repo turns them on with `checks: pr-title` and `checks: pr-description`
// in relayrunner.yml (src/checks/repo-config.ts).

import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { createDb } from "../db/index.ts";
import type { Env } from "../env.ts";
import { postFreeCheck } from "./free-checks.ts";
import { appInstallationToken } from "../github/github-app.ts";
import { checkConventionalTitle } from "./native-checks.ts";
import { loadRepoConfig, type ConfigResult } from "./repo-config.ts";
import { log } from "../log.ts";

const PR_TITLE_CHECK_NAME = "PR title";
const PR_DESCRIPTION_CHECK_NAME = "PR description";

type PullRequestMessage = Extract<WebhookMessage, { event: "pull_request" }>;
type Config = Extract<ConfigResult, { kind: "config" }>;

function checkRun(name: string, headSha: string, ok: boolean, title: string, summary: string) {
  return {
    name,
    headSha,
    conclusion: ok ? ("success" as const) : ("failure" as const),
    title,
    summary,
  };
}

/**
 * The check run for a title under the repo's config, or null when the repo hasn't turned the
 * check on.
 */
export function prTitleCheckRun(config: Config, title: string, headSha: string) {
  if (!config.prTitle) return null;
  const result = checkConventionalTitle(title, config.prTitle.types);
  return result.ok
    ? checkRun(
        PR_TITLE_CHECK_NAME,
        headSha,
        true,
        "Conventional Commit title",
        `"${title}" is a Conventional Commit.`,
      )
    : checkRun(
        PR_TITLE_CHECK_NAME,
        headSha,
        false,
        "Not a Conventional Commit title",
        result.reason,
      );
}

/**
 * The check run for a description under the repo's config, or null when the check is off. HTML
 * comments don't count, so an untouched PR template still fails.
 */
export function prDescriptionCheckRun(config: Config, body: string, headSha: string) {
  if (!config.prDescription) return null;
  const { minLength } = config.prDescription;
  const length = descriptionText(body).length;
  const ok = length >= minLength;
  const [title, summary] = ok
    ? ["Has a description", "The pull request has a description."]
    : length === 0
      ? ["No description", "Add a description that says what this pull request changes and why."]
      : [
          "Description too short",
          `The description has ${length} characters. This repo asks for at least ${minLength}.`,
        ];
  return checkRun(PR_DESCRIPTION_CHECK_NAME, headSha, ok, title, summary);
}

// The description's own words: no HTML comments (PR templates' hints) and no runs of spaces.
function descriptionText(body: string) {
  return body
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A relayrunner.yml that doesn't parse fails the "PR title" check with the reason, since the repo
// meant to configure something. One check says it, not one per check.
function invalidConfigRun(config: Extract<ConfigResult, { kind: "invalid" }>, headSha: string) {
  return checkRun(
    PR_TITLE_CHECK_NAME,
    headSha,
    false,
    `${config.path} is invalid`,
    `RelayRunner couldn't read ${config.path} on the default branch: ${config.error}`,
  );
}

/**
 * The check runs for a pull request event. An edit runs only the checks for what it changed, so a
 * description edit doesn't post a new title check.
 */
export function pullRequestCheckRuns(
  config: ConfigResult,
  pullRequest: PullRequestMessage["pullRequest"],
) {
  const { title, body, headSha, changed } = pullRequest;
  if (config.kind === "none") return [];
  if (config.kind === "invalid") return [invalidConfigRun(config, headSha)];
  // Each check with the field it reads.
  const checks = [
    { field: "title", run: () => prTitleCheckRun(config, title, headSha) },
    { field: "body", run: () => prDescriptionCheckRun(config, body, headSha) },
  ];
  return checks
    .filter(({ field }) => !changed || changed.includes(field))
    .map(({ run }) => run())
    .filter((check) => check !== null);
}

/** Posts the check runs for a pull request that opened, was edited or got new commits. */
export async function checkPullRequest(env: Env, message: PullRequestMessage) {
  const { installationId } = message;
  // A closed pull request has nothing left to check.
  if (!installationId || message.action === "closed") return;
  const repo = message.repository.fullName;
  const token = await appInstallationToken(env, installationId);
  const config = await loadRepoConfig(token, repo);
  if (config.kind === "none") return;
  const db = createDb(env.DB);
  const pull = { repository: message.repository, number: message.pullRequest.number };
  await Promise.all(
    pullRequestCheckRuns(config, message.pullRequest).map(async (check) => {
      await postFreeCheck(db, token, installationId, pull, check);
      log.info("checks.pull_request_checked", "pull request checked", {
        deliveryId: message.deliveryId,
        repo,
        pullRequest: message.pullRequest.number,
        config: config.path,
        check: check.name,
        conclusion: check.conclusion,
      });
    }),
  );
}
