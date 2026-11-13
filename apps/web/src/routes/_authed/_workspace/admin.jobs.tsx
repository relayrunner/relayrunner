import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Count } from "@/components/count";
import { CountChart } from "@/components/duration-chart";
import { PageHeader } from "@/components/page-header";
import { RangePicker } from "@/components/range-picker";
import { StatTile } from "@/components/stat-tile";
import { DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { WorkspaceMark } from "@/components/workspace-menu";
import { getJobCounts, type JobCountReport, type JobCounts } from "@/lib/admin";
import { percent } from "@/lib/utils";

const RANGES = [1, 7, 30, 90] as const;

// Operator admin, behind Cloudflare Access and an operator session (apps/api/src/routes/admin.ts).
export const Route = createFileRoute("/_authed/_workspace/admin/jobs")({
  loader: () => getJobCounts(7, false),
  component: JobsPage,
});

const jobsIn = (counts: JobCounts) => counts.success + counts.failed + counts.cancelled;
const RESULTS = [
  ["success", "Succeeded"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
] as const;

function JobsPage() {
  const [report, setReport] = useState<JobCountReport>(Route.useLoaderData());
  const [internal, setInternal] = useState(false);

  function load(days: number, withInternal: boolean) {
    setInternal(withInternal);
    getJobCounts(days, withInternal)
      .then(setReport)
      .catch(() => undefined);
  }

  const { totals, days } = report;
  const jobs = jobsIn(totals);

  return (
    <section className="grid max-w-5xl gap-6">
      <PageHeader title="Jobs">
        Jobs that finished in every workspace's repos, by how they ended. Skipped jobs and picks
        aren't counted.
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangePicker ranges={RANGES} days={days} onChange={(next) => load(next, internal)} />
        {report.internalWorkspaces > 0 && (
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-go)]"
              checked={internal}
              onChange={(event) => load(days, event.target.checked)}
            />
            Include our own workspaces ({report.internalWorkspaces})
          </label>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Jobs" value={<Count value={jobs} />} />
        {RESULTS.map(([result, label]) => (
          <StatTile
            key={result}
            label={label}
            value={<Count value={totals[result]} />}
            detail={jobs ? percent(totals[result] / jobs) : undefined}
          />
        ))}
      </div>

      <CountChart tallies={report.hours} days={days} noun="job" />

      <DataTable
        columns={columns}
        data={report.installations}
        getRowId={(row) => String(row.installationId)}
        initialSorting={[{ id: "jobs", desc: true }]}
        empty="No finished jobs in this range."
      />
    </section>
  );
}

type Row = JobCountReport["installations"][number];

const column = dataTableColumns<Row>();
const number = (
  id: string,
  header: string,
  value: (row: Row) => number,
  text: (value: number) => ReactNode = (value) => <Count value={value} />,
) =>
  column.accessor(value, {
    id,
    header,
    sortFn: "basic",
    sortDescFirst: true,
    meta: NUM,
    cell: ({ getValue }) => text(getValue()),
  });

const columns = column.columns([
  column.accessor("name", {
    header: "Workspace",
    sortFn: "text",
    cell: ({ row }) => (
      <div className="flex items-center gap-2.5">
        <WorkspaceMark
          name={row.original.name}
          logo={row.original.logo}
          className="size-6 text-xs"
        />
        <div className="min-w-0">
          <div className="font-medium">{row.original.name}</div>
          {row.original.accountLogin !== row.original.name && (
            <div className="text-xs text-muted-foreground">{row.original.accountLogin}</div>
          )}
        </div>
      </div>
    ),
  }),
  number("jobs", "Jobs", jobsIn),
  number("success", "Succeeded", (row) => row.success),
  number("failed", "Failed", (row) => row.failed),
  number("failureRate", "Failure rate", (row) => row.failed / Math.max(jobsIn(row), 1), percent),
  number("cancelled", "Cancelled", (row) => row.cancelled),
]);
