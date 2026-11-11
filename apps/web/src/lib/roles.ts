// The dashboard's copy of apps/api/src/roles.ts (#134). The API enforces these; the dashboard
// uses them only to hide controls someone can't use.
export type Role = "owner" | "admin" | "member";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** Owner or admin: manages GitHub accounts, runner order and members. */
export function canManage(role: string | null | undefined) {
  return role === "owner" || role === "admin";
}

/**
 * Whether `actor` may change `target`'s role or remove them. Mirrors Better Auth: only owners
 * touch owners, and nobody edits themselves here (leaving is separate).
 */
export function canEditMember(
  actor: { role: string; userId: string },
  target: { role: string; userId: string },
) {
  if (!canManage(actor.role) || actor.userId === target.userId) return false;
  return target.role !== "owner" || actor.role === "owner";
}

/** The roles `actor` may give someone, by invite or role change. Only owners make owners. */
export function assignableRoles(actorRole: string): Role[] {
  return actorRole === "owner" ? ["member", "admin", "owner"] : ["member", "admin"];
}

/** A RelayRunner operator (user.role, not a workspace role): sees the sidebar's Admin section. */
export function isOperator(user: { role?: string | null } | null | undefined) {
  return user?.role === "operator";
}
