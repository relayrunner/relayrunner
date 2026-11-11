import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordEvent } from "./activity.ts";
import { type Db, schema } from "./db/index.ts";
import type { Env } from "./env.ts";

// Better Auth's two ways out of a workspace. Its afterRemoveMember hook only fires for the first
// and doesn't say who did it, so createAuth runs onMemberRemoved from a global after-hook instead.
export const MEMBER_REMOVAL_PATHS = ["/organization/remove-member", "/organization/leave"] as const;

// What those endpoints return on success: remove-member wraps the member, leave returns it bare.
const RemovedMember = z.object({ userId: z.string(), organizationId: z.string() });
const RemovalResponse = z.union([z.object({ member: RemovedMember }), RemovedMember]);

/**
 * The member a successful removal or leave returned, or null for anything else (an error, or a
 * shape this doesn't know).
 */
export function removedMember(returned: unknown) {
  const parsed = RemovalResponse.safeParse(returned);
  if (!parsed.success) return null;
  return "member" in parsed.data ? parsed.data.member : parsed.data;
}

/**
 * A member is gone from a workspace: log it. Their machines are theirs, not the workspace's
 * (#318), so they stay enrolled; the workspace just stops listing them and routing to them.
 * `actorUserId` is who removed them (them, when they `left`), or null if the request's session
 * couldn't be read.
 */
export async function onMemberRemoved(
  _env: Env,
  db: Db,
  removal: { workspaceId: string; userId: string; actorUserId: string | null; left: boolean },
) {
  const [user] = await db
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, removal.userId))
    .limit(1);
  await recordEvent(db, {
    workspaceId: removal.workspaceId,
    type: "member.removed",
    data: {
      memberName: user?.name ?? "A member",
      left: removal.left,
    },
    actorUserId: removal.actorUserId,
  });
}
