import { useMemo, useState } from "react";
import { SharingDialog } from "@/components/machine-sharing";
import {
  BandLabel,
  MachineChip,
  MachineJobLink,
  MachineMenu,
  MachineOwner,
  MachineRuns,
  NotReported,
  revokeVerb,
  TypicalJob,
  useMachineActions,
  type MachineView,
} from "@/components/runner-card";
import { Button } from "@/components/ui/button";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Stat } from "@/lib/job-times";
import type { Machine } from "@/lib/machines";
import { STATUSES } from "@/lib/runner-filters";
import { cn } from "@/lib/utils";

export type RunnerRow = {
  machine: Machine;
  view: MachineView;
  /** Who it belongs to, as the filter menu names it. */
  owner: string;
  /** Offline with no jobs for a while, so hidden unless asked for. */
  inactive: boolean;
};

const [RowContext, useRowContext] = createCellContext<{
  jobTimes: Record<string, Stat>;
  onRemovedFromWorkspace?: () => void;
  /** Opens the table's one sharing dialog for a row. */
  openSharing: (row: RunnerRow) => void;
}>("Runner list");

const STATUS_ORDER = Object.fromEntries(STATUSES.map((status, index) => [status.value, index]));
const getRowId = (row: RunnerRow) => row.machine.id;
const rowClassName = (row: { original: RunnerRow }) =>
  cn(row.original.view.tone === "offline" && "bg-dormant");

const column = dataTableColumns<RunnerRow>();
const columns = column.columns([
  column.accessor((row) => row.machine.name, {
    id: "name",
    header: "Runner",
    sortFn: "text",
    cell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-2.5">
        <MachineChip view={row.original.view} />
        <span
          title={row.original.machine.name}
          className="max-w-40 truncate font-mono text-[13px] font-medium"
        >
          {row.original.machine.name}
        </span>
      </span>
    ),
  }),
  column.accessor((row) => STATUS_ORDER[row.view.tone], {
    id: "status",
    header: "Status",
    sortFn: "basic",
    meta: { className: "min-w-52" },
    cell: ({ row }) => {
      const { view } = row.original;
      return (
        <span className="grid min-w-0 gap-0.5 text-xs">
          <BandLabel tone={view.tone}>{view.label}</BandLabel>
          {view.busy ? (
            <span className="flex max-w-60">
              <MachineJobLink jobs={view.jobs} />
            </span>
          ) : (
            view.detail && (
              <span className="truncate text-muted-foreground" title={view.detail}>
                {view.detail}
              </span>
            )
          )}
        </span>
      );
    },
  }),
  column.accessor("owner", {
    header: "Owner",
    sortFn: "text",
    cell: ({ row }) => (
      <span className="flex text-ink-2">
        <MachineOwner machine={row.original.machine} view={row.original.view} />
      </span>
    ),
  }),
  column.display({
    id: "runs",
    header: "Runs",
    cell: ({ row }) => <RunsCell row={row.original} />,
  }),
  // Platform over hardware, so the row stays narrow enough for the dashboard's width.
  column.accessor((row) => row.view.platform, {
    id: "platform",
    header: "Platform",
    sortFn: "text",
    meta: { className: "whitespace-nowrap text-xs text-ink-2" },
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <span>{row.original.view.platform || <NotReported />}</span>
        {row.original.view.hardware && (
          <span className="text-muted-foreground">{row.original.view.hardware}</span>
        )}
      </span>
    ),
  }),
  column.display({
    id: "typical",
    header: "Typical job",
    meta: { align: "end", className: "whitespace-nowrap text-ink-2" },
    cell: ({ row }) => <TypicalCell machineId={row.original.machine.id} />,
  }),
  column.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { className: "px-2 py-2 text-right" },
    cell: ({ row }) => <RowActions row={row.original} />,
  }),
]);

/** Self-hosted runners as a table: one row each, sortable, with the card's menu at the end. */
export function RunnerList({
  rows,
  jobTimes,
  onRemovedFromWorkspace,
}: {
  rows: RunnerRow[];
  jobTimes: Record<string, Stat>;
  onRemovedFromWorkspace?: () => void;
}) {
  const [sharing, setSharing] = useState<RunnerRow | null>(null);
  const context = useMemo(
    () => ({ jobTimes, onRemovedFromWorkspace, openSharing: setSharing }),
    [jobTimes, onRemovedFromWorkspace],
  );
  return (
    <RowContext value={context}>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={getRowId}
        initialSorting={[{ id: "status", desc: false }]}
        rowHeight={57}
        rowClassName={rowClassName}
      />
      {sharing && (
        <SharingDialog
          key={sharing.machine.id}
          machineId={sharing.machine.id}
          machineName={sharing.machine.name}
          sharing={sharing.view.sharing}
          open
          onOpenChange={(open) => !open && setSharing(null)}
        />
      )}
    </RowContext>
  );
}

function TypicalCell({ machineId }: { machineId: string }) {
  const { jobTimes } = useRowContext();
  return <TypicalJob jobTime={jobTimes[machineId]} />;
}

function RunsCell({ row }: { row: RunnerRow }) {
  const { openSharing } = useRowContext();
  return (
    <span className="flex text-xs text-ink-2">
      <MachineRuns view={row.view} onChange={() => openSharing(row)} />
    </span>
  );
}

// The card's menu, with the revoke confirm in a dialog since a row has no band to hold it.
function RowActions({ row }: { row: RunnerRow }) {
  const { machine, view } = row;
  const { onRemovedFromWorkspace, openSharing } = useRowContext();
  const actions = useMachineActions(machine, onRemovedFromWorkspace);
  const { pending, error } = actions;
  return (
    <span className="inline-flex items-center gap-2">
      {error && !actions.confirming && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
      <MachineMenu
        machine={machine}
        view={view}
        actions={{ ...actions, setSharingOpen: () => openSharing(row) }}
      />
      <Dialog open={actions.confirming} onOpenChange={actions.setConfirming}>
        <DialogContent className="text-left">
          <DialogHeader>
            <DialogTitle>
              {view.isGithub
                ? `Remove ${machine.name} from RelayRunner?`
                : `Revoke ${machine.name}?`}
            </DialogTitle>
            <DialogDescription>
              {view.isGithub
                ? "It stays registered on GitHub."
                : "Its token stops working, so it has to run relayrunner connect again."}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending !== null}
              onClick={() => actions.setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending !== null}
              onClick={() => void actions.act("revoke")}
            >
              {revokeVerb(view, pending === "revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}
