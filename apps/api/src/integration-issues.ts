/**
 * Workspace integrations that stopped working and need someone in the workspace to fix them: the
 * App paused (suspended) on GitHub, a provider rejecting its API token, or a telemetry export or log bucket
 * that paused after days of failed sends. A permission the App lacks, like billing reads, isn't one:
 * GitHub already asks owners to accept new permissions, and the dashboard shows what's missing.
 * The hourly cron reads them
 * from the rows that already record each failure and keeps one health issue per problem
 * (src/health-issues.ts). The health alert sweep then tells each one on its schedule (first alert,
 * two reminders over a week, then quiet): to the workspace's owners and admins by email, and to
 * operators in Slack.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { WorkspaceProblem } from "@relayrunner/email";
import { providerName } from "@relayrunner/providers";
import { type Db, schema } from "./db/index.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";
import { installationSettingsUrl } from "./github.ts";
import { type HealthAlert, recordOutcomes } from "./health-issues.ts";
import { MANAGER_ROLES } from "./roles.ts";

/** A problem, its health issue key, and what operators read about it. */
export type IntegrationProblem = WorkspaceProblem & {
  key: string;
  workspaceId: string;
  summary: string;
};

const w = schema.workspace;

/** Every problem open now, by its health issue key. */
export async function findIntegrationProblems(db: Db): Promise<IntegrationProblem[]> {
  const [suspended, providers, exports, buckets] = await Promise.all([
    db
      .select({
        workspaceId: w.id,
        id: schema.githubInstallation.id,
        accountLogin: schema.githubInstallation.accountLogin,
        accountType: schema.githubInstallation.accountType,
      })
      .from(schema.githubInstallation)
      .innerJoin(w, eq(w.installationId, schema.githubInstallation.id))
      .where(isNotNull(schema.githubInstallation.suspendedAt)),
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
    ...suspended.map(({ workspaceId, ...installation }) => ({
      key: `integration:app-suspended:${workspaceId}`,
      workspaceId,
      kind: "app-suspended" as const,
      account: installation.accountLogin,
      settingsUrl: installationSettingsUrl(installation),
      summary: "the App is paused (suspended) on GitHub",
    })),
    ...providers.map(({ workspaceId, provider }) => ({
      key: `integration:provider-token:${workspaceId}:${provider}`,
      workspaceId,
      kind: "provider-token" as const,
      providerName: providerName(provider),
      summary: `${providerName(provider)} rejected its API token`,
    })),
    ...exports.map(({ workspaceId }) => ({
      key: `integration:telemetry-paused:${workspaceId}`,
      workspaceId,
      kind: "telemetry-paused" as const,
      summary: "the telemetry export paused",
    })),
    ...buckets.map(({ workspaceId }) => ({
      key: `integration:log-bucket-paused:${workspaceId}`,
      workspaceId,
      kind: "log-bucket-paused" as const,
      summary: "the log archive paused",
    })),
  ];
}

/** The hourly check: opens an issue for each new problem and clears issues whose problem is gone. */
export async function checkIntegrations(env: Env, db: Db, now = new Date()) {
  const [problems, open] = await Promise.all([
    findIntegrationProblems(db),
    db
      .select({ key: schema.healthIssue.key })
      .from(schema.healthIssue)
      .where(and(eq(schema.healthIssue.kind, "integration"), isNull(schema.healthIssue.clearedAt))),
  ]);
  const known = new Set(open.map((row) => row.key));
  const current = new Set(problems.map((problem) => problem.key));
  const started = problems.filter((problem) => !known.has(problem.key));
  // Only changes are written: a problem that stays open keeps its row as it is.
  await recordOutcomes(
    db,
    [
      ...started.map(({ key, summary }) => ({ key, kind: "integration" as const, error: summary })),
      ...[...known]
        .filter((key) => !current.has(key))
        .map((key) => ({ key, kind: "integration" as const })),
    ],
    now,
  );
  return problems.length;
}

/**
 * Emails the owners and admins of each workspace whose integration alert is due (from
 * sendHealthAlerts), re-reading each problem for what the email links to.
 */
export async function emailWorkspaceAdmins(env: Env, db: Db, alerts: HealthAlert[]) {
  const due = new Map(
    alerts
      .filter((alert) => alert.kind === "integration" && alert.state === "failing")
      .map((alert) => [alert.key, alert.reminder]),
  );
  if (!due.size) return;
  const problems = (await findIntegrationProblems(db)).filter((problem) => due.has(problem.key));
  await Promise.all(
    problems.map((problem) => emailProblem(env, db, problem, due.get(problem.key) ?? false)),
  );
}

async function emailProblem(env: Env, db: Db, problem: IntegrationProblem, reminder: boolean) {
  const admins = await db
    .select({ userId: schema.user.id, email: schema.user.email, workspace: w.name })
    .from(schema.workspaceMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
    .innerJoin(w, eq(w.id, schema.workspaceMember.workspaceId))
    .where(
      and(
        eq(schema.workspaceMember.workspaceId, problem.workspaceId),
        inArray(schema.workspaceMember.role, [...MANAGER_ROLES]),
      ),
    );
  const { key: _key, workspaceId: _workspaceId, summary: _summary, ...context } = problem;
  await Promise.all(
    admins.map(({ userId, email, workspace }) =>
      sendEmail(env, {
        to: email,
        userId,
        template: "integration-problem",
        context: { ...context, workspace, reminder },
      }),
    ),
  );
}
