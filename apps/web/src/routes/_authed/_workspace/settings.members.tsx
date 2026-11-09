import { createFileRoute, useRouter } from "@tanstack/react-router";
import { EllipsisIcon, UserMinusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authDisabled } from "@/lib/auth-client";
import {
  cancelInvitation,
  getMembersData,
  inviteMember,
  leaveWorkspace,
  memberErrorMessage,
  removeMember,
  updateMemberRole,
  type Invitation,
  type Member,
  type MembersData,
} from "@/lib/members";
import { ROLE_LABELS, assignableRoles, canEditMember, canManage, type Role } from "@/lib/roles";

export const Route = createFileRoute("/_authed/_workspace/settings/members")({
  loader: ({ context }): Promise<MembersData> =>
    authDisabled
      ? Promise.resolve({ members: [], invitations: [], machineCounts: {} })
      : getMembersData(context.current.workspace.id),
  component: MembersPage,
});

function MembersPage() {
  const { current, user } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const { workspace, role } = current;
  const me = { role, userId: user?.id ?? "" };
  const manager = canManage(role);
  const owners = data.members.filter((member) => member.role === "owner").length;

  return (
    <section>
      <PageHeader title="Members">
        Everyone here shares {workspace.name}'s machines. Owners and admins manage GitHub accounts,
        the runner order and members.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        {manager && <InviteCard workspaceId={workspace.id} actorRole={role} />}

        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">
              Members{" "}
              <span className="font-normal text-muted-foreground">{data.members.length}</span>
            </CardTitle>
            {manager && (
              <CardDescription>
                Removing someone revokes the machines they enrolled.
              </CardDescription>
            )}
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

        {data.invitations.length > 0 && (
          <Card className="py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">
                Pending invites{" "}
                <span className="font-normal text-muted-foreground">{data.invitations.length}</span>
              </CardTitle>
              <CardDescription>Links expire 48 hours after they're sent.</CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              <ul className="grid divide-y">
                {data.invitations.map((invitation) => (
                  <InviteRow
                    key={invitation.id}
                    invitation={invitation}
                    workspaceId={workspace.id}
                    // Only owners can resend or cancel an owner invite.
                    editable={manager && (invitation.role !== "owner" || role === "owner")}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <LeaveCard workspace={workspace} lastOwner={role === "owner" && owners <= 1} />
      </div>
    </section>
  );
}

function InviteCard({ workspaceId, actorRole }: { workspaceId: string; actorRole: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ kind: "sent" | "error"; message: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setPending(true);
    setStatus(null);
    try {
      await inviteMember(workspaceId, address, role);
      setStatus({ kind: "sent", message: `Invite sent to ${address}.` });
      setEmail("");
      await router.invalidate();
    } catch (error) {
      setStatus({ kind: "error", message: memberErrorMessage(error, "Couldn't send the invite.") });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Invite someone</CardTitle>
        <CardDescription>
          They get an email link and join after signing in with that address.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        <form onSubmit={(event) => void submit(event)} className="flex flex-wrap gap-2">
          <Input
            type="email"
            required
            aria-label="Email"
            placeholder="name@company.com"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-w-0 flex-1 basis-56"
          />
          <Select value={role} onValueChange={(value) => setRole(value as Role)}>
            <SelectTrigger aria-label="Role" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assignableRoles(actorRole).map((option) => (
                <SelectItem key={option} value={option}>
                  {ROLE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send invite"}
          </Button>
        </form>
        {status && (
          <p
            role={status.kind === "error" ? "alert" : "status"}
            className={
              status.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
            }
          >
            {status.message}
          </p>
        )}
      </CardContent>
    </Card>
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
  const [confirming, setConfirming] = useState(false);
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

  async function remove() {
    setPending(true);
    setError(null);
    try {
      await removeMember(workspace.id, member.id);
      setConfirming(false);
      await router.invalidate();
    } catch (cause) {
      setError(memberErrorMessage(cause, "Couldn't remove them. Try again."));
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
          <>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`More actions for ${name}`}
                  disabled={pending}
                >
                  <EllipsisIcon aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                  <UserMinusIcon aria-hidden />
                  Remove…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <Badge variant={member.role === "member" ? "idle" : "outline"}>{roleLabel}</Badge>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {name}?</DialogTitle>
            <DialogDescription>
              They lose access to {workspace.name}
              {machines > 0
                ? `, and the ${machines === 1 ? "machine" : `${machines} machines`} they enrolled ${
                    machines === 1 ? "is" : "are"
                  } revoked right away. A job already running finishes first.`
                : "."}{" "}
              You can invite them again later.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => void remove()}>
              {pending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function InviteRow({
  invitation,
  workspaceId,
  editable,
}: {
  invitation: Invitation;
  workspaceId: string;
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"resend" | "cancel" | null>(null);
  const [note, setNote] = useState<{ kind: "sent" | "error"; message: string } | null>(null);
  const expiresAt = new Date(invitation.expiresAt);
  const expired = expiresAt.getTime() <= Date.now();

  async function act(action: "resend" | "cancel") {
    setPending(action);
    setNote(null);
    try {
      if (action === "resend") {
        await inviteMember(workspaceId, invitation.email, invitation.role, true);
        setNote({ kind: "sent", message: "Sent again." });
      } else {
        await cancelInvitation(invitation.id);
      }
      await router.invalidate();
    } catch (cause) {
      setNote({
        kind: "error",
        message: memberErrorMessage(cause, `Couldn't ${action}. Try again.`),
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
        <span className="truncate text-sm">{invitation.email}</span>
        <span className="text-xs text-muted-foreground">
          {ROLE_LABELS[invitation.role as Role] ?? invitation.role} ·{" "}
          {expired ? <span className="text-run">Expired</span> : `Expires ${expiresIn(expiresAt)}`}
          {note && (
            <span className={note.kind === "error" ? "text-destructive" : undefined}>
              {" "}
              · {note.message}
            </span>
          )}
        </span>
      </div>
      {editable && (
        <div className="ml-auto flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void act("resend")}
          >
            {pending === "resend" ? "Sending…" : "Resend"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => void act("cancel")}
          >
            {pending === "cancel" ? "Canceling…" : "Cancel"}
          </Button>
        </div>
      )}
    </li>
  );
}

function LeaveCard({
  workspace,
  lastOwner,
}: {
  workspace: { id: string; name: string };
  lastOwner: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    setPending(true);
    setError(null);
    try {
      const next = await leaveWorkspace(workspace.id);
      await router.invalidate();
      await router.navigate({ to: next ? "/runners" : "/workspaces/new" });
    } catch (cause) {
      setError(memberErrorMessage(cause, "Couldn't leave the workspace. Try again."));
      setPending(false);
    }
  }

  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Leave {workspace.name}</CardTitle>
        <CardDescription>
          {lastOwner
            ? "You're the only owner. Make someone else an owner before you leave."
            : "The machines you enrolled here are revoked when you leave."}
        </CardDescription>
        {!lastOwner && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
              Leave…
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <Dialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave {workspace.name}?</DialogTitle>
            <DialogDescription>
              You lose access to its runners and activity, and the machines you enrolled here are
              revoked. Someone will need to invite you again to come back.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => void leave()}>
              {pending ? "Leaving…" : "Leave workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
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

function expiresIn(date: Date) {
  const hours = Math.round((date.getTime() - Date.now()) / 3_600_000);
  if (hours < 1) return "in under an hour";
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}
