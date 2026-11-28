// When each pull request opened, merged and closed, from the main App's pull_request deliveries
// (opened, reopened, synchronize, edited and closed all carry the dates), for the Usage page's
// Pull requests table (src/reports/pull-request-minutes.ts).
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { sql } from "drizzle-orm";
import { type Db, isMissingTable, schema } from "../db/index.ts";
import { findInstallation } from "../github/installations.ts";

const table = schema.pullRequest;

type PullRequestMessage = Extract<WebhookMessage, { event: "pull_request" }>;

const dateOf = (iso: string | null) => (iso === null ? null : new Date(iso));

/** Stores the pull request's dates. False when its installation isn't one RelayRunner knows. */
export async function recordPullRequest(db: Db, message: PullRequestMessage): Promise<boolean> {
  const { installationId, repository, pullRequest, receivedAt } = message;
  if (!installationId || !(await findInstallation(db, installationId))) return false;
  const values = {
    installationId,
    repositoryFullName: repository.fullName,
    openedAt: dateOf(pullRequest.openedAt),
    mergedAt: dateOf(pullRequest.mergedAt),
    closedAt: dateOf(pullRequest.closedAt),
    githubUpdatedAt: new Date(pullRequest.updatedAt ?? receivedAt),
  };
  try {
    await db
      .insert(table)
      .values({ repositoryId: repository.id, number: pullRequest.number, ...values })
      .onConflictDoUpdate({
        target: [table.repositoryId, table.number],
        set: { ...values, updatedAt: new Date() },
        setWhere: sql`excluded.github_updated_at >= ${table.githubUpdatedAt}`,
      });
  } catch (error) {
    // Deployed ahead of its migration: the dates are a nicety, so the delivery's checks go on.
    if (isMissingTable(error)) return false;
    throw error;
  }
  return true;
}
