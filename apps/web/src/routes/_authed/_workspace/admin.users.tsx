import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { AdminDeleteDialog } from "@/components/admin-delete-dialog";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
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
import { timeAgo } from "@/lib/activity";
import {
  deletedNotice,
  deleteUser,
  listUsers,
  listWorkspaces,
  setUserRole,
  type AdminUser,
  type UserRole,
} from "@/lib/admin";

// Operator admin, behind Cloudflare Access and an operator session (apps/api/src/routes/admin.ts).
export const Route = createFileRoute("/_authed/_workspace/admin/users")({
  // Workspaces too, so the delete dialog can say which go with a user.
  loader: async () => {
    const [{ users }, { workspaces }] = await Promise.all([listUsers(), listWorkspaces()]);
    return { users, workspaces };
  },
  component: UsersPage,
  errorComponent: ({ error }) => (
    <PageHeader title="Users">
      Couldn't load users: {error instanceof Error ? error.message : String(error)}
    </PageHeader>
  ),
});

function UsersPage() {
  const { user: me } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const [users, setUsers] = useState(data.users);
  const [workspaces, setWorkspaces] = useState(data.workspaces);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [query, setQuery] = useState("");
  const search = query.trim();
  const [notice, setNotice] = useState<string | null>(null);

  async function changeRole(target: AdminUser, role: UserRole) {
    setNotice(null);
    try {
      await setUserRole(target.id, role);
      setUsers((all) => all.map((u) => (u.id === target.id ? { ...u, role } : u)));
      setNotice(`${target.name} is now ${role === "operator" ? "an operator" : "a regular user"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  // The workspaces a delete would take with it (only member), and the ones that block it.
  const theirs = deleting
    ? workspaces.filter((w) => w.members.some((m) => m.userId === deleting.id))
    : [];
  const shared = theirs.filter((w) => w.members.length > 1);

  function startDelete(target: AdminUser) {
    setNotice(null);
    setDeleting(target);
  }

  async function remove(target: AdminUser, uninstallGitHubApp: boolean) {
    const result = await deleteUser(target.id, uninstallGitHubApp);
    const gone = new Set(result.workspaces.map((w) => w.id));
    setUsers((all) => all.filter((u) => u.id !== target.id));
    setWorkspaces((all) => all.filter((w) => !gone.has(w.id)));
    setNotice(
      [`Deleted ${target.name}.`, ...result.workspaces.map((w) => deletedNotice(w))].join(" "),
    );
  }

  return (
    <section className="grid max-w-5xl gap-6">
      <PageHeader title="Users">
        Everyone who has signed in. Operators see this Admin section. A role change shows up for
        them within five minutes. Delete is for repeating sign-up and onboarding tests.
      </PageHeader>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or email"
        aria-label="Search users"
        className="max-w-sm"
      />

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <UserActions value={{ meId: me?.id, changeRole, startDelete }}>
        <DataTable
          columns={columns}
          data={users}
          getRowId={(u) => u.id}
          search={search}
          initialSorting={[{ id: "createdAt", desc: true }]}
          empty={search ? "No one matches that search." : "No users yet."}
          rowHeight={61}
        />
      </UserActions>

      <AdminDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "user"}?`}
        confirmText={deleting?.email ?? ""}
        githubAccounts={shared.length ? [] : theirs.flatMap((w) => w.githubAccounts)}
        blocked={
          shared.length > 0 &&
          `They share ${shared.map((w) => w.name).join(", ")} with other members. Delete ${
            shared.length === 1 ? "that workspace" : "those workspaces"
          } first, or remove them from it.`
        }
        onConfirm={(uninstall) => remove(deleting!, uninstall)}
      >
        <p>
          Removes the account, its sessions and its GitHub sign-in, so a CLI signed in as them stops
          working.
          {theirs.length > 0 && !shared.length && (
            <>
              {" "}
              Also deletes {theirs.map((w) => w.name).join(", ")}, where they're the only member.
            </>
          )}
        </p>
        <p>
          GitHub still remembers they authorized the app. Revoke it under GitHub Settings,
          Applications to see GitHub's consent screen again.
        </p>
      </AdminDeleteDialog>
    </section>
  );
}

// The row cells' callbacks, so the columns can live at module scope and stay stable.
const [UserActions, useUserActions] = createCellContext<{
  meId: string | undefined;
  changeRole: (target: AdminUser, role: UserRole) => Promise<void>;
  startDelete: (target: AdminUser) => void;
}>("Users");

const column = dataTableColumns<AdminUser>();
const columns = column.columns([
  // Name and email together, so search finds either and sorting goes by name.
  column.accessor((u) => `${u.name} ${u.email}`, {
    id: "user",
    header: "User",
    sortFn: "text",
    cell: ({ row }) => (
      <>
        <div className="font-medium">{row.original.name}</div>
        <div className="text-xs text-muted-foreground">{row.original.email}</div>
      </>
    ),
  }),
  column.accessor("workspaces", {
    header: "Workspaces",
    sortFn: "basic",
    sortDescFirst: true,
    enableGlobalFilter: false,
    meta: { align: "end" },
  }),
  column.accessor("createdAt", {
    header: "Joined",
    sortFn: "text",
    sortDescFirst: true,
    enableGlobalFilter: false,
    meta: { className: "whitespace-nowrap" },
    cell: ({ getValue }) => <span title={getValue()}>{timeAgo(getValue(), Date.now())}</span>,
  }),
  column.accessor((u) => u.role ?? "user", {
    id: "role",
    header: "Role",
    sortFn: "text",
    enableGlobalFilter: false,
    cell: ({ row }) => <RoleSelect user={row.original} />,
  }),
  column.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { className: "px-2 py-2 text-right" },
    cell: ({ row }) => <MoreActions user={row.original} />,
  }),
]);

function RoleSelect({ user: u }: { user: AdminUser }) {
  const { meId, changeRole } = useUserActions();
  return (
    <Select
      value={u.role ?? "user"}
      // The API refuses to demote yourself, so the control doesn't offer it.
      disabled={u.id === meId}
      onValueChange={(value) => void changeRole(u, value === "operator" ? "operator" : null)}
    >
      <SelectTrigger aria-label={`Role for ${u.name}`} className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* Select values can't be empty: a regular user is "user" here, null in the API. */}
        <SelectItem value="user">User</SelectItem>
        <SelectItem value="operator">Operator</SelectItem>
      </SelectContent>
    </Select>
  );
}

function MoreActions({ user: u }: { user: AdminUser }) {
  const { meId, startDelete } = useUserActions();
  // The API refuses to delete yourself, so the control doesn't offer it.
  if (u.id === meId) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${u.name}`}>
          <EllipsisIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={() => startDelete(u)}>
          <Trash2Icon aria-hidden />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
