import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app.ts";

// Workspace roles (#134). These are Better Auth's stock organization roles:
// - owner and admin manage GitHub installations, runner order and members.
// - member can enroll machines and revoke the ones they enrolled; everything else is read-only.
// Better Auth keeps at least one owner: it refuses to remove, demote, or let the last owner leave.
export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

const MANAGER_ROLES: ReadonlySet<string> = new Set<Role>(["owner", "admin"]);

// Owner or admin. Better Auth stores roles as text, so this takes any string.
export function canManage(role: string | null | undefined) {
  return role != null && MANAGER_ROLES.has(role);
}

// Owners and admins can revoke any machine in the workspace; members only the ones they enrolled.
export function canRevokeMachine(
  role: string,
  userId: string,
  machine: { createdBy: string | null },
) {
  return canManage(role) || (machine.createdBy !== null && machine.createdBy === userId);
}

// Owner or admin of the request's workspace. Reads the role set by requireWorkspace (or a
// route's own membership middleware), so it costs no extra query. Run it after that.
export const requireManager = createMiddleware<AppEnv>(async (c, next) => {
  if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
  await next();
});

// Global user roles (user.role), separate from workspace roles. Null is a regular user. Operators
// see the dashboard's Admin section and may use the D1 admin routes (routes/admin.ts).
export const USER_ROLES = ["operator"] as const;

export function isOperator(user: { role?: string | null } | null | undefined) {
  return user?.role === "operator";
}
