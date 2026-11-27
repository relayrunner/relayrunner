import { api } from "./api";

// Which GitHub enterprise each of the user's workspaces is in (GET /api/workspaces/enterprises),
// so the workspace switcher can group them. Only enterprises RelayRunner reads are named: an org's
// enterprise is learned from the enterprise's billing report once it installs the App.

export type Enterprise = { slug: string; avatar: string };
export type WorkspaceEnterprise = { id: string; enterprise: Enterprise | null };

export function getWorkspaceEnterprises() {
  return api<{ workspaces: WorkspaceEnterprise[] }>("/workspaces/enterprises");
}

/**
 * Workspaces in no enterprise first, then one group per enterprise in the order its first
 * workspace appears. Each keeps the list's order within it.
 */
export function groupByEnterprise<T extends { id: string }>(
  workspaces: T[],
  enterprises: WorkspaceEnterprise[],
) {
  const of = new Map(enterprises.map((row) => [row.id, row.enterprise]));
  const alone: T[] = [];
  const groups = new Map<string, { enterprise: Enterprise; workspaces: T[] }>();
  for (const workspace of workspaces) {
    const enterprise = of.get(workspace.id);
    if (!enterprise) alone.push(workspace);
    else {
      const group = groups.get(enterprise.slug) ?? { enterprise, workspaces: [] };
      group.workspaces.push(workspace);
      groups.set(enterprise.slug, group);
    }
  }
  return { alone, enterprises: [...groups.values()] };
}
