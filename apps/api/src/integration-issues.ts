/**
 * Workspace integrations that stopped working and need someone in the workspace to fix them: the
 * App suspended on GitHub, GitHub refusing billing reads, a provider rejecting its API token, or a
 * telemetry export or log bucket that paused after days of failed sends. The hourly cron reads them
 * from the rows that already record each failure and keeps one health issue per problem
 * (src/health-issues.ts), so each is told once when it starts: to the workspace's owners and admins
 * by email, and to operators in Slack.
 */
import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import type { WorkspaceProblem } from "@relayrunner/email";
import { type Db, schema } from "./db/index.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { recordFailure, recordSuccess } from "./health-issues.ts";

export type IntegrationProblem = WorkspaceProblem & { key: string; workspaceId: string };

const w = schema.workspace;

/** Every problem open now, by its health issue key. */
export async function findIntegrationProblems(db: Db): Promise<IntegrationProblem[]> {
  const [suspended, billing, providers, exports, buckets] = await Promise.all([
    db
      .select({
        workspaceId: w.id,
        installationId: schema.githubInstallation.id,
        account: schema.githubInstallation.accountLogin,
        accountType: schema.githubInstallation.accountType,
      })
      .from(schema.githubInstallation)
      .innerJoin(w, eq(w.installationId, schema.githubInstallation.id))
      .where(isNotNull(schema.githubInstallation.suspendedAt)),
    db
      .select({ workspaceId: w.id })
      .from(schema.actionsBilling)
      .innerJoin(w, eq(w.installationId, schema.actionsBilling.installationId))
      .where(eq(schema.actionsBilling.failure, "missing_permission")),
    db
      .select({
        workspaceId: schema.providerConnection.workspaceId,
        provider: schema.providerConnection.provider,
      })
      .from(schema.providerConnection)
      .where(eq(schema.providerConnection.failure, "token_rejected")),
    db
      .select({ workspaceId: schema.telemetryExport.workspaceId })
      .from(schema.telemetryExport)
      .where(isNotNull(schema.telemetryExport.pausedAt)),
    db
      .select({ workspaceId: schema.logBucket.workspaceId })
      .from(schema.logBucket)
      .where(isNotNull(schema.logBucket.pausedAt)),
  ]);
  return [
    ...suspended.map(({ workspaceId, installationId, account, accountType }) => ({
      key: `integration:app-suspended:${workspaceId}`,
      workspaceId,
      kind: "app-suspended" as const,
      account,
      settingsUrl:
        accountType === "User"
          ? `https://github.com/settings/installations/${installationId}`
          : `https://github.com/organizations/${account}/settings/installations/${installationId}`,
    })),
    ...billing.map(({ workspaceId }) => ({
      key: `integration:billing-refused:${workspaceId}`,
      workspaceId,
      kind: "billing-refused" as const,
    })),
    ...providers.map(({ workspaceId, provider }) => ({
      key: `integration:provider-token:${workspaceId}:${provider}`,
      workspaceId,
      kind: "provider-token" as const,
      provider,
    })),
    ...exports.map(({ workspaceId }) => ({
      key: `integration:telemetry-paused:${workspaceId}`,
      workspaceId,
      kind: "telemetry-paused" as const,
    })),
    ...buckets.map(({ workspaceId }) => ({
      key: `integration:log-bucket-paused:${workspaceId}`,
      workspaceId,
      kind: "log-bucket-paused" as const,
    })),
  ];
}

/**
 * The hourly check: opens an issue for each new problem, emails the workspace's owners and admins
 * about it, and clears issues whose problem is gone.
 */
export async function checkIntegrations(env: Env, db: Db, now = new Date()) {
  const problems = await findIntegrationProblems(db);
  const open = await db
    .select({ key: schema.healthIssue.key })
    .from(schema.healthIssue)
    .where(like(schema.healthIssue.key, "integration:%"));
  const known = new Set(open.map((row) => row.key));
  const current = new Set(problems.map((problem) => problem.key));
  for (const problem of problems) {
    await recordFailure(db, { key: problem.key, kind: "integration", error: problem.kind }, now);
    if (!known.has(problem.key)) await emailWorkspaceAdmins(env, db, problem);
  }
  for (const key of known) if (!current.has(key)) await recordSuccess(db, key, now);
  return problems.length;
}

async function emailWorkspaceAdmins(env: Env, db: Db, problem: IntegrationProblem) {
  const admins = await db
    .select({ userId: schema.user.id, email: schema.user.email, workspace: w.name })
    .from(schema.workspaceMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
    .innerJoin(w, eq(w.id, schema.workspaceMember.workspaceId))
    .where(
      and(
        eq(schema.workspaceMember.workspaceId, problem.workspaceId),
        inArray(schema.workspaceMember.role, ["owner", "admin"]),
      ),
    );
  const { key: _key, workspaceId: _workspaceId, ...context } = problem;
  await Promise.all(
    admins.map(({ userId, email, workspace }) =>
      sendEmail(env, {
        to: email,
        userId,
        template: "integration-problem",
        context: { ...context, workspace },
      }),
    ),
  );
}
