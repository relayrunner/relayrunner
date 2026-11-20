// Workspace roles (#134). These are Better Auth's stock organization roles:
// - owner and admin manage GitHub installations, runner order and members.
// - member is read-only, except for the auto jobs of repos they can push to on GitHub.
// The API enforces them; the dashboard uses them only to hide controls someone can't use.
export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** The roles that manage a workspace. */
export const MANAGER_ROLES = ["owner", "admin"] as const satisfies readonly Role[];
const managers: ReadonlySet<string> = new Set(MANAGER_ROLES);

/** Owner or admin. Better Auth stores roles as text, so this takes any string. */
export function canManage(role: string | null | undefined) {
  return role != null && managers.has(role);
}
