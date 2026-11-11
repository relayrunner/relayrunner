import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authDisabled } from "@/lib/auth-client";
import {
  getMembersData,
  memberErrorMessage,
  updateMemberRole,
  type Member,
  type MembersData,
} from "@/lib/members";
import { ROLE_LABELS, assignableRoles, canEditMember, canManage, type Role } from "@/lib/roles";

export const Route = createFileRoute("/_authed/_workspace/settings/members")({
  loader: ({ context }): Promise<MembersData> =>
    authDisabled
      ? Promise.resolve({ members: [], machineCounts: {} })
      : getMembersData(context.current.workspace.id),
  component: MembersPage,
});

function MembersPage() {
  const { current, user } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const { workspace, role } = current;
  const me = { role, userId: user?.id ?? "" };
  const manager = canManage(role);

  return (
    <section>
      <PageHeader title="Members">
        Everyone here shares {workspace.name}'s machines. Owners and admins manage the runner order
        and roles.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">
              Members{" "}
              <span className="font-normal text-muted-foreground">{data.members.length}</span>
            </CardTitle>
            <CardDescription>
              Membership comes from GitHub: anyone who can see {workspace.name}'s installation joins
              when they sign in, and leaves when GitHub stops showing it to them.
              {manager && " Change who's an admin or owner here."}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <ul className="grid divide-y">
              {data.members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  machines={data.machineCounts[member.userId] ?? 0}
                  isMe={member.userId === me.userId}
                  editable={canEditMember(me, member)}
                  actorRole={role}
                  workspace={workspace}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function MemberRow({
  member,
  machines,
  isMe,
  editable,
  actorRole,
  workspace,
}: {
  member: Member;
  machines: number;
  isMe: boolean;
  editable: boolean;
  actorRole: string;
  workspace: { id: string; name: string };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = member.user.name || member.user.email;
  const roleLabel = ROLE_LABELS[member.role as Role] ?? member.role;

  async function changeRole(role: string) {
    if (role === member.role) return;
    setPending(true);
    setError(null);
    try {
      await updateMemberRole(workspace.id, member.id, role);
      await router.invalidate();
    } catch (cause) {
      setError(memberErrorMessage(cause, "Couldn't change their role. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
      <Avatar name={name} image={member.user.image} />
      <div className="grid min-w-0 flex-1 basis-40 gap-0.5">
        <span className="truncate text-sm font-medium">
          {name}
          {isMe && <span className="font-normal text-muted-foreground"> (you)</span>}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {member.user.name ? `${member.user.email} · ` : ""}
          {machines} {machines === 1 ? "machine" : "machines"}
        </span>
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {editable ? (
          <Select value={member.role} onValueChange={(role) => void changeRole(role)}>
            <SelectTrigger
              size="sm"
              aria-label={`Role for ${name}`}
              disabled={pending}
              className="w-28"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {assignableRoles(actorRole).map((option) => (
                <SelectItem key={option} value={option}>
                  {ROLE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant={member.role === "member" ? "idle" : "outline"}>{roleLabel}</Badge>
        )}
      </div>
    </li>
  );
}

function Avatar({ name, image }: { name: string; image?: string | null }) {
  if (image) {
    return <img src={image} alt="" className="size-8 shrink-0 rounded-full border" />;
  }
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-secondary text-xs font-medium uppercase"
    >
      {name.slice(0, 1)}
    </span>
  );
}
