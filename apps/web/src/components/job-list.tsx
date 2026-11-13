import { memo, useMemo, useState } from "react";
import { DurationChart, jobPoints } from "@/components/duration-chart";
import { SectionBoundary } from "@/components/error-boundary";
import { ProviderLink } from "@/components/provider-link";
import { providerOf } from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { RunLink } from "@/components/run-sheet";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeAgo } from "@/lib/activity";
import { formatMemory } from "@/lib/device";
import { plural } from "@/lib/job-times";
import { authDisabled } from "@/lib/auth-client";
import {
  getJobs,
  type HistoryJob,
  isFailure,
  type JobsReport,
  isLongWait,
  sampleJobs,
} from "@/lib/runs";
import { cn, elapsed, percent } from "@/lib/utils";

const RANGES = [1, 7, 14] as const;

type ResultFilter = "all" | "failed";

/** A job with what its row shows worked out once. */
type Row = HistoryJob & { runner: string; waitMs: number | null; runMs: number };

const [ListContext, useListContext] = createCellContext<{ showRepository: boolean }>("Jobs");

const column = dataTableColumns<Row>();
const columns = column.columns([
  // Job and workflow together, so search finds either.
  column.accessor((job) => `${job.name} ${job.workflow ?? ""}`, {
    id: "job",
    header: "Job",
    sortFn: "text",
    meta: { className: "max-w-80" },
    cell: ({ row }) => <JobCell job={row.original} />,
  }),
  column.accessor("runner", {
    header: "Ran on",
    sortFn: "text",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: job } }) => (
      <ProviderLink
        provider={providerOf({ key: job.environment })}
        className="inline-flex items-center gap-2"
      >
        {job.runner}
      </ProviderLink>
    ),
  }),
  column.accessor((job) => job.waitMs ?? undefined, {
    id: "wait",
    header: "Wait",
    sortFn: "basic",
    sortDescFirst: true,
    enableGlobalFilter: false,
    meta: {
      align: "end",
      info: <p>How long the job waited from queued until a runner picked it up.</p>,
    },
    cell: ({ row: { original: job } }) => (
      <span className={cn(isLongWait(job.waitMs) && "font-semibold text-run")}>
        {elapsed(job.waitMs)}
      </span>
    ),
  }),
  column.accessor("runMs", {
    header: "Run",
    sortFn: "basic",
    sortDescFirst: true,
    enableGlobalFilter: false,
    meta: { align: "end", className: "font-semibold" },
    cell: ({ getValue }) => elapsed(getValue()),
  }),
  column.accessor((job) => job.conclusion ?? "", {
    id: "result",
    header: "Result",
    sortFn: "text",
    enableGlobalFilter: false,
    cell: ({ row }) => <ConclusionText conclusion={row.original.conclusion} />,
  }),
  column.accessor("completedAt", {
    header: "Finished",
    sortFn: "basic",
    sortDescFirst: true,
    enableGlobalFilter: false,
    meta: { align: "end", className: "whitespace-nowrap text-muted-foreground" },
    cell: ({ getValue }) => timeAgo(getValue()),
  }),
]);

// Shown when some job in the list reported what it used.
const usageColumn = (
  id: string,
  header: string,
  info: string,
  field: "cpuP95" | "memoryP95Mb",
  format: (value: number) => string,
) =>
  column.accessor((job) => job.usage?.[field], {
    id,
    header,
    sortFn: "basic",
    sortDescFirst: true,
    enableGlobalFilter: false,
    meta: { align: "end", info: <p>{info}</p> },
    cell: ({ getValue }) => {
      const value = getValue();
      return value === undefined ? "—" : format(value);
    },
  });
const usageColumns = column.columns([
  usageColumn(
    "cpu",
    "CPU",
    "The p95 of the job's CPU use, as a share of its runner's cores.",
    "cpuP95",
    percent,
  ),
  usageColumn("memory", "Memory", "The p95 of the job's memory use.", "memoryP95Mb", formatMemory),
]);
// Between Run and Result.
const result = columns.findIndex((def) => def.id === "result");
const columnsWithUsage = [...columns.slice(0, result), ...usageColumns, ...columns.slice(result)];

function JobCell({ job }: { job: Row }) {
  const { showRepository } = useListContext();
  return (
    <>
      <RunLink
        run={job}
        job={job.id}
        className="font-medium break-words underline-offset-4 hover:underline"
      >
        {job.name}
      </RunLink>
      <span className="block truncate text-xs text-muted-foreground">
        <RunLink run={job} className="underline-offset-4 hover:text-foreground hover:underline">
          {job.workflow ?? "Unnamed workflow"}
        </RunLink>
        {showRepository && ` · ${job.repository}`}
      </span>
    </>
  );
}

/** A finished job's result, colored: green success, red failure, grey anything else. */
function ConclusionText({ conclusion }: { conclusion: string | null }) {
  return (
    <span
      className={cn(
        "capitalize",
        conclusion === "success"
          ? "text-go"
          : isFailure(conclusion)
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      {(conclusion ?? "done").replace("_", " ")}
    </span>
  );
}

/**
 * Every job a runner finished, newest first: the History page's Jobs view. Memoized, so opening a
 * job's panel doesn't re-render the table.
 */
export const JobList = memo(function JobList({ report: first }: { report: JobsReport }) {
  const [report, setReport] = useState(first);
  const [repository, setRepository] = useState("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [query, setQuery] = useState("");

  const repositories = useMemo(
    () => [...new Set(report.jobs.map((job) => job.repository))].sort(),
    [report],
  );
  const rows = useMemo(() => {
    const labels = new Map(report.environments.map((env) => [env.key, env.label]));
    return report.jobs.map((job): Row => ({
      ...job,
      runner: labels.get(job.environment) ?? job.environment,
      waitMs: job.queuedAt === null ? null : job.startedAt - job.queuedAt,
      runMs: job.completedAt - job.startedAt,
    }));
  }, [report]);
  // Each range is its own load, since the newest jobs alone can fill a busy workspace's list.
  function chooseRange(days: number) {
    (authDisabled ? Promise.resolve(sampleJobs(days)) : getJobs(days))
      .then(setReport)
      .catch(() => undefined);
  }
  const shown = useMemo(
    () =>
      rows.filter(
        (job) =>
          (repository === "all" || job.repository === repository) &&
          (result === "all" || isFailure(job.conclusion)),
      ),
    [rows, repository, result],
  );
  const chartPoints = useMemo(() => jobPoints(shown), [shown]);
  const hasUsage = useMemo(() => shown.some((job) => job.usage), [shown]);
  const showRepository = repository === "all" && repositories.length > 1;
  const context = useMemo(() => ({ showRepository }), [showRepository]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <RangePicker ranges={RANGES} days={report.days} onChange={chooseRange} />
        {repositories.length > 1 && (
          <Select value={repository} onValueChange={setRepository}>
            <SelectTrigger size="sm" aria-label="Repo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All repos</SelectItem>
              {repositories.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={result} onValueChange={(value) => setResult(value as ResultFilter)}>
          <SelectTrigger size="sm" aria-label="Result">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any result</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search jobs"
          aria-label="Search jobs"
          className="h-8 w-48"
        />
      </div>
      {report.jobs.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
          No finished jobs in the last {plural(report.days, "day")}. Jobs show up here once the
          GitHub App sees them run in a connected repo.
        </p>
      ) : (
        <>
          <SectionBoundary>
            <DurationChart points={chartPoints} days={report.days} noun="job" />
          </SectionBoundary>
          <SectionBoundary>
            <ListContext value={context}>
              <DataTable
                columns={hasUsage ? columnsWithUsage : columns}
                data={shown}
                getRowId={(job) => String(job.id)}
                search={query.trim()}
                rowHeight={53}
                empty="No jobs match these filters."
              />
            </ListContext>
          </SectionBoundary>
        </>
      )}
      {report.truncated && (
        <p className="text-xs text-muted-foreground">
          Only the newest {report.jobs.length} jobs are shown.
        </p>
      )}
    </div>
  );
});
