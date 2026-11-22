// Which runner order a job walks. Every reader goes through resolveRunnerOrder, the router's pick
// (src/durable-objects/router.ts) and the order routes (src/routes/workspaces.ts) alike, so a
// repository's own order (#709) only needs adding here.
//
// Today each workspace has one order, workspace.runner_order, and every repository uses it.
// Caps don't depend on the order: GitHub minutes and provider spend are counted per GitHub
// account, and free minutes per workspace, so a repository with its own order would still share
// them with the rest of the workspace.
import { readRunnerOrder, type RunnerOrder } from "@relayrunner/runner-order";
import { eq } from "drizzle-orm";
import { type Db, schema } from "./db/index.ts";
import { sha256Hex } from "./machines.ts";

/** Where an order came from. Only the workspace's for now; a repository's own order joins it. */
export type RunnerOrderScope = "workspace";

export interface ResolvedRunnerOrder {
  order: RunnerOrder;
  scope: RunnerOrderScope;
  // The order as saved, or null when nobody saved one and the default applies.
  stored: string | null;
}

/**
 * The order a repository's jobs walk, or the workspace's when no repository is given. Every
 * repository uses the workspace's order for now.
 */
export async function resolveRunnerOrder(
  db: Db,
  workspaceId: string,
  _repositoryId?: number,
): Promise<ResolvedRunnerOrder> {
  const [row] = await db
    .select({ runnerOrder: schema.workspace.runnerOrder })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, workspaceId))
    .limit(1);
  const stored = row?.runnerOrder ?? null;
  return { order: readRunnerOrder(stored), scope: "workspace", stored };
}

/**
 * An order for the API: whether it's the default, and its version, a short hash that changes
 * whenever the order does ("default" until someone saves one).
 */
export async function presentRunnerOrder({ order, stored }: ResolvedRunnerOrder) {
  return {
    order,
    isDefault: !stored,
    version: stored ? (await sha256Hex(stored)).slice(0, 16) : "default",
  };
}
