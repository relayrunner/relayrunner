import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { AdminDeleteDialog } from "@/components/admin-delete-dialog";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createCellContext, DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/activity";
import { setupSteps, type SetupStep } from "@/lib/admin-setup";
import { cn } from "@/lib/utils";
import { WorkspaceMark } from "@/components/workspace-menu";
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
  const [showInternal, setShowInternal] = useState(false);
  const internalCount = workspaces.filter((w) => w.internal).length;
  const shown = useMemo(
    () => (showInternal ? workspaces : workspaces.filter((w) => !w.internal)),
    [workspaces, showInternal],
  );

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
        Every workspace, newest first, with its members, connected GitHub accounts, and how far it
        got with setup. A setup step shows amber when it hasn't happened a day after the one before
        it. Jobs count the past 7 days. Delete is for repeating sign-up and onboarding tests.
      </PageHeader>

      {internalCount > 0 && (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-go)]"
            checked={showInternal}
            onChange={(event) => setShowInternal(event.target.checked)}
          />
          Show our own workspaces ({internalCount}), where every member is an operator
        </label>
      )}

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <WorkspaceActions value={{ startDelete }}>
        <TooltipProvider delayDuration={150}>
          <DataTable
            columns={columns}
            data={shown}
            getRowId={(w) => w.id}
            initialSorting={[{ id: "createdAt", desc: true }]}
            empty="No workspaces yet."
          />
        </TooltipProvider>
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
          Removes the workspace with its members, machines, runner order and activity. Machines
          still connected are disconnected. Members' accounts stay.
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
      <div className="flex items-start gap-2.5">
        <WorkspaceMark
          name={row.original.name}
          logo={row.original.logo}
          className="mt-0.5 size-6 text-xs"
        />
        <div className="min-w-0">
          <div className="font-medium">{row.original.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.slug}</div>
        </div>
      </div>
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
  column.accessor((w) => setupSteps(w.setup).filter((step) => step.at).length, {
    id: "setup",
    header: "Setup",
    sortFn: "basic",
    sortDescFirst: true,
    meta: TOP,
    cell: ({ row }) => <SetupDots steps={setupSteps(row.original.setup)} />,
  }),
  column.accessor("jobs7d", {
    header: "Jobs 7d",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, className: `${NUM.className} py-3 align-top` },
    cell: ({ getValue }) => getValue().toLocaleString(),
  }),
  column.accessor((w) => (w.jobs7d ? w.machineJobs7d / w.jobs7d : -1), {
    id: "onMachine",
    header: "On machine",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, className: `${NUM.className} py-3 align-top` },
    cell: ({ row }) =>
      row.original.jobs7d ? (
        <span
          title={`${row.original.machineJobs7d} of ${row.original.jobs7d} jobs ran on a machine`}
        >
          {Math.round((row.original.machineJobs7d / row.original.jobs7d) * 100)}%
        </span>
      ) : (
        "—"
      ),
  }),
  column.accessor((w) => w.lastJobAt ?? "", {
    id: "lastJob",
    header: "Last job",
    sortFn: "text",
    sortDescFirst: true,
    meta: { className: "py-3 align-top whitespace-nowrap" },
    cell: ({ row }) =>
      row.original.lastJobAt ? (
        <span title={row.original.lastJobAt}>{timeAgo(row.original.lastJobAt, Date.now())}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
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

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** One dot per setup step: filled when done, amber when stuck, hollow while waiting. */
function SetupDots({ steps }: { steps: SetupStep[] }) {
  return (
    <ul className="flex items-center gap-1.5 pt-1" aria-label="Setup">
      {steps.map((step) => (
        <li key={step.label} className="flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${step.label}: ${stepStatus(step)}`}
                className="flex size-4 cursor-default items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-2.5 rounded-full border",
                    step.at
                      ? "border-go bg-go"
                      : step.stuck
                        ? "border-run bg-run"
                        : "border-muted-foreground/50",
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-medium">{step.label}</div>
              <div>{stepStatus(step)}</div>
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

function stepStatus(step: SetupStep) {
  if (step.at) return dateTime.format(new Date(step.at));
  if (!step.waitingSince) return "Not yet";
  const hours = Math.floor((Date.now() - new Date(step.waitingSince).getTime()) / 3_600_000);
  const waited = hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  return `Not yet, ${waited} since the step before`;
}
