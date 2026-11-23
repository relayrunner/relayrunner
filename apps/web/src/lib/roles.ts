// Workspace roles (#134), shared with the API. The API enforces them; the dashboard uses them
// only to hide controls someone can't use.
import { canManage, type Role } from "@relayrunner/api-types";

export { canManage, type Role };

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

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

/** The roles `actor` may give someone, by role change. Only owners make owners. */
export function assignableRoles(actorRole: string): Role[] {
  return actorRole === "owner" ? ["member", "admin", "owner"] : ["member", "admin"];
}

/** A RelayRunner operator (user.role, not a workspace role): sees the sidebar's Admin section. */
export function isOperator(user: { role?: string | null } | null | undefined) {
  return user?.role === "operator";
}
