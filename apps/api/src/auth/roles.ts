import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { canManage } from "@relayrunner/api-types";
import { AppError } from "@relayrunner/errors";

// Workspace roles (#134). These are Better Auth's stock organization roles:
// - owner and admin manage GitHub installations, runner order and members.
// - member is read-only here, except for the auto jobs of repos they can push to on GitHub
//   (repo-access.ts). Connected machines belong to their user, not the workspace (#318), so only
//   that user controls one, whatever their role.
// Better Auth keeps at least one owner: it refuses to remove, demote, or let the last owner leave.
export { canManage, MANAGER_ROLES, type Role } from "@relayrunner/api-types";

// Who may pause, rename, share or revoke a machine (#318): a connected machine only by its owner,
// in any workspace it shows up in; a runner adopted from GitHub, which is the org's, by the
// workspace's owners and admins.
export function canControlMachine(
  role: string | null | undefined,
  userId: string,
  machine: { source: string; userId: string | null },
) {
  if (machine.source === "github") return canManage(role);
  return machine.userId !== null && machine.userId === userId;
}

// Owner or admin of the request's workspace. Reads the role set by requireWorkspace (or a
// route's own membership middleware), so it costs no extra query. Run it after that.
export const requireManager = createMiddleware<AppEnv>(async (c, next) => {
  if (!canManage(c.var.role))
    throw new AppError("FORBIDDEN", { message: "Only owners and admins can do that." });
  await next();
});

// Global user roles (user.role), separate from workspace roles. Null is a regular user. Operators
// see the dashboard's Admin section and may use the D1 admin routes (routes/admin.ts).
export const USER_ROLES = ["operator"] as const;

export function isOperator(user: { role?: string | null } | null | undefined) {
  return user?.role === "operator";
}
