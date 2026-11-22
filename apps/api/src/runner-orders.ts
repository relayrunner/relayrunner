// Which runner order a job walks. Every reader goes through resolveRunnerOrder, the router's pick
// (src/durable-objects/router.ts) and the order routes (src/routes/workspaces.ts) alike.
//
// Each workspace has an order, workspace.runner_order, and a repository can have its own
// (repo_runner_order, #709): a full copy its jobs walk instead. Caps don't depend on the order:
// GitHub minutes and provider spend are counted per GitHub account, and free minutes per
// workspace, so a repository with its own order shares them with the rest of the workspace.
import { readRunnerOrder, type RunnerOrder } from "@relayrunner/runner-order";
import { and, asc, eq } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { sha256Hex } from "./machines.ts";

/** Where an order came from: the workspace's, or the repository's own. */
export type RunnerOrderScope = "workspace" | "repository";

export interface ResolvedRunnerOrder {
  order: RunnerOrder;
  scope: RunnerOrderScope;
  // The order as saved, or null when nobody saved one and the default applies.
  stored: string | null;
}

const own = schema.repoRunnerOrder;

/**
 * The order a repository's jobs walk: its own if it has one, else the workspace's. The
 * workspace's when no repository is given.
 */
export async function resolveRunnerOrder(
  db: Db,
  workspaceId: string,
  repositoryId?: number,
): Promise<ResolvedRunnerOrder> {
  const [row] = await db
    .select({ workspace: schema.workspace.runnerOrder, repository: own.runnerOrder })
    .from(schema.workspace)
    .leftJoin(
      own,
      and(
        eq(own.workspaceId, schema.workspace.id),
        // No repository matches no row: ids are GitHub's, never negative.
        eq(own.repositoryId, repositoryId ?? -1),
      ),
    )
    .where(eq(schema.workspace.id, workspaceId))
    .limit(1);
  if (row?.repository) {
    return { order: readRunnerOrder(row.repository), scope: "repository", stored: row.repository };
  }
  const stored = row?.workspace ?? null;
  return { order: readRunnerOrder(stored), scope: "workspace", stored };
}

/**
 * An order for the API: where it came from, whether it's the default, and its version, a short
 * hash that changes whenever the order does ("default" until someone saves one). A repository's
 * own order hashes differently from the same steps inherited, so giving a repository its own order
 * changes its version.
 */
export async function presentRunnerOrder({ order, scope, stored }: ResolvedRunnerOrder) {
  const hashed = scope === "repository" ? `repository:${stored}` : stored;
  return {
    order,
    scope,
    isDefault: !stored,
    version: hashed ? (await sha256Hex(hashed)).slice(0, 16) : "default",
  };
}

/** The repositories with their own order, by name. */
export function listRepoRunnerOrders(db: Db, workspaceId: string) {
  return db
    .select({ repositoryId: own.repositoryId, repository: own.repository })
    .from(own)
    .where(eq(own.workspaceId, workspaceId))
    .orderBy(asc(own.repository));
}

/** Gives a repository its own order, or replaces the one it has. */
export function saveRepoRunnerOrder(
  db: Db,
  workspaceId: string,
  repo: { id: number; fullName: string },
  stored: string,
  userId: string,
) {
  const values = {
    repository: repo.fullName,
    runnerOrder: stored,
    updatedBy: userId,
    updatedAt: new Date(),
  };
  return db
    .insert(own)
    .values({ workspaceId, repositoryId: repo.id, ...values })
    .onConflictDoUpdate({ target: [own.workspaceId, own.repositoryId], set: values });
}

/** Puts a repository back on the workspace's order. */
export function removeRepoRunnerOrder(db: Db, workspaceId: string, repositoryId: number) {
  return db
    .delete(own)
    .where(and(eq(own.workspaceId, workspaceId), eq(own.repositoryId, repositoryId)));
}
