import { getRouteApi } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { BranchHeading, toggleKey } from "@/components/branch-heading";
import { DurationChart, jobPoints } from "@/components/duration-chart";
import { SectionBoundary } from "@/components/error-boundary";
import { TimeRangePicker } from "@/components/range-picker";
import { CommitBy } from "@/components/commit";
import { RunLink } from "@/components/run-sheet";
import { RunnerLink, type RunnerRef } from "@/components/runner-link";
import {
  createCellContext,
  DataTable,
  dataTableColumns,
  type DataTableRow,
} from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePageReport } from "@/lib/query";
import { timeAgo } from "@/lib/activity";
import { dayHeading } from "@/lib/time-zone";
import { formatMemory } from "@/lib/device";
import { type BranchGroup, groupByBranch } from "@/lib/branch-groups";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import {
  HISTORY_DEFAULT_RANGE,
  type HistoryJob,
  isFailure,
  type JobsReport,
  isLongWait,
  jobsQuery,
} from "@/lib/runs";
import { JOB_RANGES } from "@/lib/job-times";
import { rangeSearch, unlessDefault, useSetSearch } from "@/lib/search-params";
import { rangePhrase } from "@/lib/time-range";
import { cn, elapsed, percent } from "@/lib/utils";
import type { HistorySearch } from "@/routes/_authed/_workspace/history";
import { PublicRepoMark } from "@/components/public-repo";

const ranges = rangeSearch(JOB_RANGES, HISTORY_DEFAULT_RANGE);
// The range and filters live in the History page's URL.
const history = getRouteApi("/_authed/_workspace/history");

type ResultFilter = "all" | "failed";

/**
 * A job with what its row shows worked out once. With `group`, a pull request or branch's heading
 * holding its jobs as subRows; its own fields are its newest job's, so groups sort by them.
 */
type Row = HistoryJob & {
  env: RunnerRef;
  runner: string;
  waitMs: number | null;
  runMs: number;
  group?: BranchGroup<Row>;
  subRows?: Row[];
};

// Set when someone turns grouping off, so the list groups by default.
const FLAT_KEY = "relayrunner:history:jobs-flat";

/** Jobs under a heading row per pull request or branch; jobs with no known branch stand alone. */
function groupRows(rows: Row[]): Row[] {
  return groupByBranch(rows).map((group) =>
    group.branch === null ? group.jobs[0]! : { ...group.jobs[0]!, group, subRows: group.jobs },
  );
}

// A group's jobs: indented on a rail that drops from its heading's toggle, with no dividers between
// them, only a short one from the rail where a new commit's jobs start.
const GROUPED_ROW =
  "[&>td:first-child]:relative [&>td:first-child]:pl-10 [&>td:first-child]:before:absolute [&>td:first-child]:before:inset-y-0 [&>td:first-child]:before:left-[21.5px] [&>td:first-child]:before:w-px [&>td:first-child]:before:bg-border";
const NEW_COMMIT =
  "[&>td:not(:first-child)]:border-t [&>td:first-child]:after:absolute [&>td:first-child]:after:top-0 [&>td:first-child]:after:right-0 [&>td:first-child]:after:left-[21.5px] [&>td:first-child]:after:h-px [&>td:first-child]:after:bg-border";

function groupedRowClass(
  row: DataTableRow<Row>,
  around: { previous?: DataTableRow<Row>; next?: DataTableRow<Row> },
) {
  if (row.original.group) return "bg-secondary/20 hover:bg-secondary/20 [&>td]:py-2 [&>td]:pl-3";
  if (row.depth === 0) return undefined;
  const { previous, next } = around;
  return cn(
    GROUPED_ROW,
    next?.parentId === row.parentId && "border-b-0",
    previous &&
      previous.parentId === row.parentId &&
      previous.original.sha !== row.original.sha &&
      NEW_COMMIT,
  );
}

// Day headings go by when a job finished, as the list is ordered.
const daySection = (row: Row) => dayHeading(row.completedAt);

const rowId = (row: Row) => (row.group ? `group:${row.group.key}` : String(row.id));

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
    // Phones show the runner under the job's name instead.
    meta: { className: "whitespace-nowrap", hideOnPhone: true },
    cell: ({ row: { original: job } }) => (
      <RunnerLink runner={job.env} className="inline-flex items-center gap-2" />
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
      hideOnPhone: true,
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
    meta: { align: "end", className: "font-semibold whitespace-nowrap" },
    cell: ({ getValue }) => elapsed(getValue()),
  }),
  column.accessor((job) => job.conclusion ?? "", {
    id: "result",
    header: "Result",
    sortFn: "text",
    enableGlobalFilter: false,
    meta: { hideOnPhone: true },
    cell: ({ row }) => <ConclusionText conclusion={row.original.conclusion} />,
  }),
  column.accessor("completedAt", {
    header: "Finished",
    sortFn: "basic",
    sortDescFirst: true,
    enableGlobalFilter: false,
    meta: { align: "end", hideOnPhone: true, className: "whitespace-nowrap text-muted-foreground" },
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
    meta: { align: "end", hideOnPhone: true, info: <p>{info}</p> },
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
      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 text-xs text-muted-foreground sm:flex-nowrap">
        <span className="truncate">
          <RunLink run={job} className="underline-offset-4 hover:text-foreground hover:underline">
            {job.workflow ?? "Unnamed workflow"}
          </RunLink>
          {showRepository && (
            <>
              {` · ${job.repository}`}
              <PublicRepoMark repository={job.repository} />
            </>
          )}
        </span>
        <CommitBy actor={job.actor} sha={job.sha} repository={job.repository} />
      </span>
      {/* Phones leave out the Ran on and Result columns, so the runner and any result that
          isn't success go here. */}
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-xs sm:hidden">
        <RunnerLink
          runner={job.env}
          className="inline-flex items-center gap-1.5"
          markClassName="size-3.5"
        />
        {job.conclusion !== "success" && <ConclusionText conclusion={job.conclusion} />}
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
  const range = history.useSearch({ select: ranges.rangeOf });
  const repository = history.useSearch({ select: (search) => search.repo ?? "all" });
  const result = history.useSearch({
    select: (search): ResultFilter => (search.result === "failed" ? "failed" : "all"),
  });
  const query = history.useSearch({ select: (search) => search.q ?? "" });
  const chart = history.useSearch({ select: (search) => search.chart });
  const [flat, setFlat] = useState(() => readFlag(FLAT_KEY));
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const setSearch = useSetSearch<HistorySearch>();
  const { report } = usePageReport(jobsQuery(range), first);

  const repositories = useMemo(
    () => [...new Set(report.jobs.map((job) => job.repository))].sort(),
    [report],
  );
  const rows = useMemo(() => {
    const environments = new Map(report.environments.map((env) => [env.key, env]));
    return report.jobs.map((job): Row => {
      const env = environments.get(job.environment) ?? {
        key: job.environment,
        label: job.environment,
      };
      return {
        ...job,
        env,
        runner: env.label,
        waitMs: job.queuedAt === null ? null : job.startedAt - job.queuedAt,
        runMs: job.completedAt - job.startedAt,
      };
    });
  }, [report]);
  const shown = useMemo(
    () =>
      rows.filter(
        (job) =>
          (repository === "all" || job.repository === repository) &&
          (result === "all" || isFailure(job.conclusion)),
      ),
    [rows, repository, result],
  );
  // A search looks for jobs, so it lists them on their own.
  const grouped = !flat && !query.trim();
  const tableRows = useMemo(() => (grouped ? groupRows(shown) : shown), [grouped, shown]);
  const expanded = useMemo(
    () =>
      Object.fromEntries(
        tableRows.flatMap((row) =>
          row.group && !folded.has(row.group.key) ? [[rowId(row), true]] : [],
        ),
      ),
    [tableRows, folded],
  );
  const chartPoints = useMemo(() => jobPoints(shown), [shown]);
  const hasUsage = useMemo(() => shown.some((job) => job.usage), [shown]);
  const showRepository = repository === "all" && repositories.length > 1;
  const context = useMemo(() => ({ showRepository }), [showRepository]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <TimeRangePicker
          {...JOB_RANGES}
          value={range}
          onChange={(next) => setSearch(ranges.toSearch(next))}
        />
        {repositories.length > 1 && (
          <Select
            value={repository}
            onValueChange={(next) => setSearch({ repo: unlessDefault(next, "all") })}
          >
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
        <Select
          value={result}
          onValueChange={(next) =>
            setSearch({ result: unlessDefault(next as ResultFilter, "all") })
          }
        >
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
          onChange={(event) => setSearch({ q: event.target.value || undefined })}
          placeholder="Search jobs"
          aria-label="Search jobs"
          className="h-8 w-48"
        />
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={!flat}
          className={cn("ml-auto", flat && "text-muted-foreground")}
          onClick={() => {
            saveFlag(FLAT_KEY, !flat);
            setFlat(!flat);
          }}
        >
          <GitPullRequestIcon aria-hidden />
          Group by pull request
        </Button>
      </div>
      {report.jobs.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
          No finished jobs in {rangePhrase(range)}. Jobs show up here once the GitHub App sees them
          run in a connected repo.
        </p>
      ) : (
        <>
          <SectionBoundary>
            <DurationChart
              points={chartPoints}
              range={range}
              noun="job"
              group={chart}
              onGroup={(next) => setSearch({ chart: next })}
              groupLabel="Job"
            />
          </SectionBoundary>
          <SectionBoundary>
            <ListContext value={context}>
              <DataTable
                columns={hasUsage ? columnsWithUsage : columns}
                data={tableRows}
                getRowId={rowId}
                getSubRows={(row) => row.subRows}
                expanded={grouped ? expanded : undefined}
                rowClassName={groupedRowClass}
                fullRow={(row) => {
                  const group = row.group;
                  return (
                    group && (
                      <BranchHeading
                        group={group}
                        open={!folded.has(group.key)}
                        onToggle={() => setFolded((keys) => toggleKey(keys, group.key))}
                      />
                    )
                  );
                }}
                sectionOf={daySection}
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
