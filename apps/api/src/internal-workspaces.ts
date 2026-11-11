/**
 * Our own workspaces: the ones every member of is an operator, such as the relayrunner org and the
 * test repos' accounts. Admin › Workspaces hides them by default so early-access accounts stand
 * out, and operator pings skip them. A workspace with any non-operator member counts as a real
 * one, so a customer who adds an operator to their org never disappears.
 *
 * Right after the App is installed the workspace can have no members yet, before they sync. Then
 * it's ours only when an operator installed it: the installation's installer_github_id is an
 * operator's GitHub sign-in.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";

const IS_OPERATOR = sql`coalesce(${schema.user.role}, '') = 'operator'`;

// Workspaces with no members whose App an operator installed.
function memberlessInstalledByOperator(db: Db, workspaceId?: string) {
  return db
    .select({ workspaceId: schema.workspace.id })
    .from(schema.workspace)
    .innerJoin(
      schema.githubInstallation,
      eq(schema.githubInstallation.id, schema.workspace.installationId),
    )
    .innerJoin(
      schema.account,
      and(
        eq(schema.account.providerId, "github"),
        eq(
          schema.account.accountId,
          sql`cast(${schema.githubInstallation.installerGithubId} as text)`,
        ),
      ),
    )
    .innerJoin(schema.user, eq(schema.user.id, schema.account.userId))
    .leftJoin(schema.workspaceMember, eq(schema.workspaceMember.workspaceId, schema.workspace.id))
    .where(
      and(
        isNull(schema.workspaceMember.id),
        IS_OPERATOR,
        workspaceId ? eq(schema.workspace.id, workspaceId) : undefined,
      ),
    );
}

export async function internalWorkspaceIds(db: Db): Promise<Set<string>> {
  const [allOperators, memberless] = await Promise.all([
    db
      .select({ workspaceId: schema.workspaceMember.workspaceId })
      .from(schema.workspaceMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
      .groupBy(schema.workspaceMember.workspaceId)
      .having(sql`min(${IS_OPERATOR}) = 1`),
    memberlessInstalledByOperator(db),
  ]);
  return new Set([...allOperators, ...memberless].map((row) => row.workspaceId));
}

/** Whether one workspace is ours, for a single check such as an operator ping. */
export async function isInternalWorkspace(db: Db, workspaceId: string) {
  const [row] = await db
    .select({
      members: sql<number>`count(*)`,
      operators: sql<number>`coalesce(sum(${IS_OPERATOR}), 0)`,
    })
    .from(schema.workspaceMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
    .where(eq(schema.workspaceMember.workspaceId, workspaceId));
  if (row && row.members > 0) return row.operators === row.members;
  return (await memberlessInstalledByOperator(db, workspaceId)).length > 0;
}
