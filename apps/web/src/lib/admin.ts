import type { CatalogProvider } from "@relayrunner/providers/catalog";
import { api } from "@/lib/api";
import type { Setup } from "@/lib/admin-setup";

/** Operator admin over users and workspaces (apps/api/src/routes/admin.ts). */
export type UserRole = "operator" | null;

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: UserRole;
  createdAt: string;
  /** When they last agreed to the Terms of Service and Privacy Policy. */
  legalAgreedAt: string | null;
  /** How many workspaces they belong to. */
  workspaces: number;
};

export type AdminWorkspace = {
  id: string;
  name: string;
  slug: string;
  /** The GitHub account's avatar (#316). */
  logo: string | null;
  createdAt: string;
  members: { userId: string; name: string; email: string; role: string }[];
  githubAccounts: string[];
  /** Every member is an operator: one of our own, like the test repos' accounts. */
  internal: boolean;
  /** When each setup step first happened, or null when it hasn't yet. */
  setup: Setup;
  /** Jobs a runner ran in the past 7 days, picks left out. */
  jobs7d: number;
  /** How many of those ran on a machine. */
  machineJobs7d: number;
  /** The latest job, from the 31 days of jobs kept. */
  lastJobAt: string | null;
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
  /** Still installed on GitHub; its next installation webhook makes the workspace again. */
  forgotten: string[];
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
  if (workspace.forgotten.length)
    parts.push(`${workspace.forgotten.join(", ")} forgotten but still installed`);
  return `${parts.join(", ")}.`;
}

/** A runner price row (apps/api/src/routes/admin-prices.ts). Base-list rows have no id. */
export type AdminPriceRow = {
  id: string | null;
  usd: number;
  from: string;
  source: string | null;
  createdBy: string | null;
};

export type AdminRate = {
  provider: string;
  rate: string;
  per: "vcpu" | "runner";
  current: number | null;
  rows: AdminPriceRow[];
};

/** A price the daily check found, waiting for an operator. */
export type PendingPrice = {
  id: string;
  provider: string;
  rate: string;
  per: "vcpu" | "runner";
  usd: number;
  from: string;
  source: string | null;
  /** What jobs are priced at on that day now. */
  current: number | null;
};

/** The price check's last run on one provider's page. */
export type PriceCheckStatus = { provider: string; checkedAt: string; error: string | null };

export function listPrices() {
  return api<{ rates: AdminRate[]; pending: PendingPrice[]; checks: PriceCheckStatus[] }>(
    "/admin/prices",
  );
}

export function approvePrice(id: string) {
  return api<{ price: AdminPriceRow }>(`/admin/prices/${encodeURIComponent(id)}/approve`, {
    method: "POST",
  });
}

export function dismissPrice(id: string) {
  return api<{ ok: true }>(`/admin/prices/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
}

export function runPriceCheck() {
  return api<{ ok: true }>("/admin/prices/check", { method: "POST" });
}

export type NewPrice = {
  provider: string;
  rate: string;
  usd: number;
  from: string;
  source?: string;
};

export function addPrice(price: NewPrice) {
  return api<{ price: AdminPriceRow }>("/admin/prices", {
    method: "POST",
    body: JSON.stringify(price),
  });
}

export function removePrice(id: string) {
  return api<{ ok: true }>(`/admin/prices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** What an operator saves for a provider (apps/api/src/routes/admin-providers.ts). */
export type ProviderFields = {
  name: string;
  summary: string;
  labels: string;
  /** Matching label prefixes; only used for providers operators add. */
  prefixes: string[];
  example: string;
  setup: string;
  dashboardUrl: string;
  docsUrl: string;
  /** An https image for an added provider's mark. */
  logoUrl: string;
};

export function listProviders() {
  return api<{ providers: CatalogProvider[] }>("/admin/providers");
}

export function addProvider(provider: ProviderFields & { id: string }) {
  return api<{ ok: true }>("/admin/providers", {
    method: "POST",
    body: JSON.stringify(provider),
  });
}

export function saveProvider(id: string, provider: ProviderFields) {
  return api<{ ok: true }>(`/admin/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(provider),
  });
}

/** Puts a provider in code back as it was, or removes one an operator added. */
export function removeProvider(id: string) {
  return api<{ ok: true }>(`/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Jobs that finished, by result. */
export type JobCounts = { success: number; failed: number; cancelled: number };

/** Admin › Jobs (apps/api/src/job-counts.ts): finished jobs across every workspace. */
export type JobCountReport = {
  days: number;
  totals: JobCounts;
  /** Per hour with jobs, oldest first. */
  hours: (JobCounts & { at: number })[];
  /** Per GitHub installation that had jobs, most first. */
  installations: (JobCounts & {
    installationId: number;
    accountLogin: string;
    workspaceId: string | null;
    name: string;
    logo: string | null;
    internal: boolean;
  })[];
  /** How many of our own workspaces exist, counted or not. */
  internalWorkspaces: number;
};

export function getJobCounts(days: number, internal: boolean) {
  return api<JobCountReport>(`/admin/jobs?days=${days}&internal=${internal ? 1 : 0}`);
}
