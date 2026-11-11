import { api } from "@/lib/api";
import { organization } from "@/lib/auth-client";

// The Members page (#136) reads members and changes roles through Better Auth's stock organization
// endpoints (/api/auth/organization/*); the gateway adds only machine counts. Who's a member comes
// from GitHub (#317), so there's no inviting, removing or leaving here.

export type Member = {
  id: string;
  userId: string;
  role: string;
  createdAt: string | Date;
  user: { id: string; name: string; email: string; image?: string | null };
};

export type MembersData = {
  members: Member[];
  /** Live machines each user enrolled, by user id. */
  machineCounts: Record<string, number>;
};

/** Better Auth's error code, or a generic message, as a thrown Error. */
function fail(error: { code?: string; message?: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), { code: error?.code });
}

export async function getMembersData(workspaceId: string): Promise<MembersData> {
  const [members, counts] = await Promise.all([
    organization.listMembers({ query: { organizationId: workspaceId, limit: 200 } }),
    api<{ counts: Record<string, number> }>("/workspaces/current/machine-counts"),
  ]);
  if (members.error) fail(members.error, "Couldn't load members.");
  return {
    members: members.data.members as Member[],
    machineCounts: counts.counts,
  };
}

export async function updateMemberRole(workspaceId: string, memberId: string, role: string) {
  const { error } = await organization.updateMemberRole({
    organizationId: workspaceId,
    memberId,
    role: role as "member",
  });
  if (error) fail(error, "Couldn't change the role.");
}

/** A friendlier line for Better Auth's error codes. */
export function memberErrorMessage(error: unknown, fallback: string) {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER":
      return "A workspace needs at least one owner. Make someone else an owner first.";
    default:
      return fallback;
  }
}
