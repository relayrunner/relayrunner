import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { AdminDeleteDialog } from "@/components/admin-delete-dialog";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const now = Date.now();

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

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-2 font-medium">Workspace</th>
              <th className="px-4 py-2 font-medium">GitHub</th>
              <th className="px-4 py-2 font-medium">Members</th>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((workspace) => (
              <tr key={workspace.id} className="border-b align-top last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium">{workspace.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{workspace.slug}</div>
                </td>
                <td className="px-4 py-3">
                  {workspace.githubAccounts.length ? workspace.githubAccounts.join(", ") : "—"}
                </td>
                <td className="px-4 py-3">
                  <ul className="grid gap-1">
                    {workspace.members.map((member) => (
                      <li key={member.userId} className="flex flex-wrap items-center gap-1.5">
                        <span title={member.email}>{member.name}</span>
                        <Badge variant="idle">
                          {ROLE_LABELS[member.role as Role] ?? member.role}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-3 whitespace-nowrap" title={workspace.createdAt}>
                  {timeAgo(workspace.createdAt, now)}
                </td>
                <td className="px-2 py-2 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`More actions for ${workspace.name}`}
                      >
                        <EllipsisIcon aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          setNotice(null);
                          setDeleting(workspace);
                        }}
                      >
                        <Trash2Icon aria-hidden />
                        Delete…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
