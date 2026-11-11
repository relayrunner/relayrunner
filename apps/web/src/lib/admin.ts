import { api } from "@/lib/api";

/** Operator admin over users and workspaces (apps/api/src/routes/admin.ts). */
export type UserRole = "operator" | null;

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: UserRole;
  createdAt: string;
  /** How many workspaces they belong to. */
  workspaces: number;
};

export type AdminWorkspace = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  members: { userId: string; name: string; email: string; role: string }[];
  githubAccounts: string[];
};

export function listUsers() {
  return api<{ users: AdminUser[] }>("/admin/users");
}

export function setUserRole(id: string, role: UserRole) {
  return api<{ user: { id: string; role: UserRole } }>(`/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function listWorkspaces() {
  return api<{ workspaces: AdminWorkspace[] }>("/admin/workspaces");
}

/** What an operator delete removed (apps/api/src/admin-delete.ts). */
export type DeletedWorkspace = {
  id: string;
  name: string;
  machines: number;
  uninstalled: string[];
  unclaimed: string[];
};

export function deleteWorkspace(id: string, uninstallGitHubApp: boolean) {
  return api<{ workspace: DeletedWorkspace }>(`/admin/workspaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ uninstallGitHubApp }),
  });
}

export function deleteUser(id: string, uninstallGitHubApp: boolean) {
  return api<{ workspaces: DeletedWorkspace[] }>(`/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ uninstallGitHubApp }),
  });
}

/** One line for what a delete removed. */
export function deletedNotice(workspace: DeletedWorkspace) {
  const parts = [`Deleted ${workspace.name}`];
  if (workspace.machines)
    parts.push(`${workspace.machines} machine${workspace.machines === 1 ? "" : "s"}`);
  if (workspace.uninstalled.length)
    parts.push(`uninstalled from ${workspace.uninstalled.join(", ")}`);
  if (workspace.unclaimed.length) parts.push(`${workspace.unclaimed.join(", ")} left unclaimed`);
  return `${parts.join(", ")}.`;
}
