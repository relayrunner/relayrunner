import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { AdminDeleteDialog } from "@/components/admin-delete-dialog";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { timeAgo } from "@/lib/activity";
import { deleteWorkspace, deletedNotice, listWorkspaces, type AdminWorkspace } from "@/lib/admin";
import { ROLE_LABELS, type Role } from "@/lib/roles";

// Operator admin, behind Cloudflare Access and an operator session (apps/api/src/routes/admin.ts).
export const Route = createFileRoute("/_authed/_workspace/admin/workspaces")({
  loader: () => listWorkspaces(),
  component: WorkspacesPage,
  errorComponent: ({ error }) => (
    <PageHeader title="Workspaces">
      Couldn't load workspaces: {error instanceof Error ? error.message : String(error)}
    </PageHeader>
  ),
});

function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState(Route.useLoaderData().workspaces);
  const [deleting, setDeleting] = useState<AdminWorkspace | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function startDelete(target: AdminWorkspace) {
    setNotice(null);
    setDeleting(target);
  }

  async function remove(target: AdminWorkspace, uninstallGitHubApp: boolean) {
    const { workspace } = await deleteWorkspace(target.id, uninstallGitHubApp);
    setWorkspaces((all) => all.filter((w) => w.id !== target.id));
    setNotice(deletedNotice(workspace));
  }

  return (
    <section className="grid max-w-5xl gap-6">
      <PageHeader title="Workspaces">
        Every workspace, newest first, with its members and connected GitHub accounts. Members
        manage their own roles under each workspace's settings. Delete is for repeating sign-up and
        onboarding tests.
      </PageHeader>

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <WorkspaceActions value={{ startDelete }}>
        <DataTable
          columns={columns}
          data={workspaces}
          getRowId={(w) => w.id}
          initialSorting={[{ id: "createdAt", desc: true }]}
          empty="No workspaces yet."
        />
      </WorkspaceActions>

      <AdminDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "workspace"}?`}
        confirmText={deleting?.slug ?? ""}
        githubAccounts={deleting?.githubAccounts ?? []}
        onConfirm={(uninstall) => remove(deleting!, uninstall)}
      >
        <p>
          Removes the workspace with its members, invites, machines, runner order and activity.
          Machines still connected are disconnected. Members' accounts stay.
        </p>
      </AdminDeleteDialog>
    </section>
  );
}

const [WorkspaceActions, useWorkspaceActions] = createCellContext<{
  startDelete: (target: AdminWorkspace) => void;
}>("Workspaces");

const TOP = { className: "py-3 align-top" };

const column = dataTableColumns<AdminWorkspace>();
const columns = column.columns([
  column.accessor("name", {
    header: "Workspace",
    sortFn: "text",
    meta: TOP,
    cell: ({ row }) => (
      <>
        <div className="font-medium">{row.original.name}</div>
        <div className="font-mono text-xs text-muted-foreground">{row.original.slug}</div>
      </>
    ),
  }),
  column.accessor((w) => w.githubAccounts.join(", "), {
    id: "github",
    header: "GitHub",
    sortFn: "text",
    meta: TOP,
    cell: ({ getValue }) => getValue() || "—",
  }),
  column.accessor((w) => w.members.length, {
    id: "members",
    header: "Members",
    sortFn: "basic",
    sortDescFirst: true,
    meta: TOP,
    cell: ({ row }) => (
      <ul className="grid gap-1">
        {row.original.members.map((member) => (
          <li key={member.userId} className="flex flex-wrap items-center gap-1.5">
            <span title={member.email}>{member.name}</span>
            <Badge variant="idle">{ROLE_LABELS[member.role as Role] ?? member.role}</Badge>
          </li>
        ))}
      </ul>
    ),
  }),
  column.accessor("createdAt", {
    header: "Created",
    sortFn: "text",
    sortDescFirst: true,
    meta: { className: "py-3 align-top whitespace-nowrap" },
    cell: ({ getValue }) => <span title={getValue()}>{timeAgo(getValue(), Date.now())}</span>,
  }),
  column.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { className: "px-2 py-2 text-right align-top" },
    cell: ({ row }) => <MoreActions workspace={row.original} />,
  }),
]);

function MoreActions({ workspace }: { workspace: AdminWorkspace }) {
  const { startDelete } = useWorkspaceActions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${workspace.name}`}>
          <EllipsisIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={() => startDelete(workspace)}>
          <Trash2Icon aria-hidden />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
