import { createFileRoute } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { PageTabs, type Tab, viewOf } from "@/components/page-tabs";
import { ProviderLink } from "@/components/provider-link";
import { ProviderMark, providerOf } from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import {
  createCellContext,
  DataTable,
  type DataTableRow,
  dataTableColumns,
  type ExpandedState,
} from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authDisabled } from "@/lib/auth-client";
import {
  clock,
  DAY_MS,
  environmentColor,
  type EnvironmentSummary,
  getJobRuns,
  getJobTimes,
  type JobRow,
  type JobRun,
  type JobTimesReport,
  medianText,
  plural,
  type Stat,
  sampleJobTimes,
  spreadText,
  versusLabel,
  type WorkflowRow,
} from "@/lib/job-times";
import { cn } from "@/lib/utils";

const RANGES = [7, 14, 30] as const;

function load(days: number) {
  return authDisabled ? Promise.resolve(sampleJobTimes(days)) : getJobTimes(days);
}

const TABS = [
  { value: "workflows", label: "Workflows" },
  { value: "jobs", label: "Jobs" },
  { value: "runners", label: "Runners" },
] as const satisfies Tab<string>[];
type View = (typeof TABS)[number]["value"];

export const Route = createFileRoute("/_authed/_workspace/performance")({
  validateSearch: (search: Record<string, unknown>): { view?: View } => ({
    view: viewOf(TABS, search.view),
  }),
  loader: () => load(14),
  // Every tab reads the same report, so switching tabs doesn't load it again.
  shouldReload: ({ cause }) => cause !== "stay",
  component: PerformancePage,
});

type Detail = { workflow: WorkflowRow; job: JobRow };

function PerformancePage() {
  const first = Route.useLoaderData();
  const view = Route.useSearch({ select: (search) => search.view ?? "workflows" });
  const [report, setReport] = useState<JobTimesReport>(first);
  const [repository, setRepository] = useState<string>("all");
  const [detail, setDetail] = useState<Detail | null>(null);

  function chooseRange(days: number) {
    load(days)
      .then(setReport)
      .catch(() => undefined);
  }

  const repositories = useMemo(
    () => [...new Set(report.workflows.map((workflow) => workflow.repository))].sort(),
    [report],
  );
  // Filtered here, from the rows already loaded, so switching repos reads nothing more.
  const workflows = useMemo(
    () =>
      repository === "all"
        ? report.workflows
        : report.workflows.filter((workflow) => workflow.repository === repository),
    [report, repository],
  );
  const showRepository = repository === "all" && repositories.length > 1;

  // Memoized, since the Jobs table (memoized too) takes it as its toolbar.
  const filters = useMemo(
    () => (
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
      </div>
    ),
    [report.days, repositories, repository],
  );

  return (
    <section>
      <PageHeader title="Performance">
        How long your workflows and jobs usually take, and how each runner compares. Times come from
        successful runs, so failures that stop early don't skew them.
      </PageHeader>
      <PageTabs tabs={TABS} value={view} />
      <div className="grid gap-6">
        {/* The Jobs table puts them in a row with its Expand all. */}
        {(view !== "jobs" || report.environments.length === 0) && filters}
        {report.environments.length === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            No finished jobs in the last {report.days} days. Jobs show up here once the GitHub App
            sees them run in a connected repo.
          </p>
        ) : (
          <SectionBoundary>
            {view === "runners" ? (
              <Environments report={report} />
            ) : view === "jobs" ? (
              <Jobs
                environments={report.environments}
                workflows={workflows}
                showRepository={showRepository}
                onOpen={setDetail}
                toolbar={filters}
              />
            ) : (
              <Workflows workflows={workflows} showRepository={showRepository} onOpen={setDetail} />
            )}
          </SectionBoundary>
        )}
      </div>
      {detail && (
        <SectionBoundary>
          <JobDetail
            detail={detail}
            days={report.days}
            environments={report.environments}
            onClose={() => setDetail(null)}
          />
        </SectionBoundary>
      )}
    </section>
  );
}

function Swatch({ index }: { index: number }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-[3px]"
      style={{ background: environmentColor(index) }}
    />
  );
}

const [Baseline, useBaseline] = createCellContext<{
  key: string | null;
  label: string | undefined;
  fewRuns: number;
  minSharedJobs: number;
}>("Runners");

const END = { align: "end" } as const;

const environmentColumn = dataTableColumns<EnvironmentSummary>();
const environmentColumns = environmentColumn.columns([
  environmentColumn.accessor("label", {
    header: "Runner",
    sortFn: "text",
    cell: ({ row: { original: env } }) => (
      <ProviderLink provider={providerOf(env)} className="flex w-fit items-center gap-2.5">
        <span>
          <span className="block whitespace-nowrap">{env.label}</span>
          {env.detail && (
            <span className="block text-xs whitespace-nowrap text-muted-foreground">
              {env.detail}
            </span>
          )}
        </span>
      </ProviderLink>
    ),
  }),
  environmentColumn.accessor((env) => env.stat.runs, {
    id: "jobs",
    header: "Jobs",
    sortFn: "basic",
    sortDescFirst: true,
    meta: END,
    cell: ({ getValue }) => getValue().toLocaleString(),
  }),
  environmentColumn.accessor((env) => env.stat.waitMs ?? undefined, {
    id: "wait",
    header: "Median wait",
    sortFn: "basic",
    meta: {
      ...END,
      info: <p>How long jobs waited from queued until this runner picked them up.</p>,
    },
    cell: ({ row }) => clock(row.original.stat.waitMs),
  }),
  environmentColumn.accessor((env) => env.stat.medianMs ?? undefined, {
    id: "run",
    header: "Median run",
    sortFn: "basic",
    meta: {
      align: "end",
      className: "font-semibold",
      info: (
        <>
          <p>
            The median run time of every job this runner ran, from successful runs only, since a
            failure stops early.
          </p>
          <p>
            Runners that ran different jobs can't be compared here. The comparison column lines up
            the same jobs instead.
          </p>
        </>
      ),
    },
    cell: ({ row }) => clock(row.original.stat.medianMs),
  }),
  environmentColumn.accessor(
    (env) => (env.stat.runs ? env.stat.successes / env.stat.runs : undefined),
    {
      id: "success",
      header: "Success",
      sortFn: "basic",
      sortDescFirst: true,
      meta: END,
      cell: ({ getValue }) => {
        const share = getValue();
        return share === undefined ? "—" : `${Math.round(share * 100)}%`;
      },
    },
  ),
  environmentColumn.accessor((env) => env.versus?.ratio, {
    id: "versus",
    header: () => <VersusHead />,
    sortFn: "basic",
    meta: { className: "whitespace-nowrap", info: <VersusInfo />, label: "Vs. baseline" },
    cell: ({ row }) => <VersusCell env={row.original} />,
  }),
]);

function VersusHead() {
  const { label } = useBaseline();
  return label ? `Vs. ${label}` : "Vs. baseline";
}

function VersusInfo() {
  const { label = "the baseline", fewRuns, minSharedJobs } = useBaseline();
  return (
    <>
      <p>
        How fast this runner is on the same jobs as {label}, so different workloads don't skew it.
      </p>
      <p>
        A job counts once it has {fewRuns} successful runs on both. The number is the typical job's
        speedup, so one odd job can't swing it, and it shows once {minSharedJobs} jobs count.
      </p>
    </>
  );
}

function VersusCell({ env }: { env: EnvironmentSummary }) {
  return <Versus env={env} isBaseline={env.key === useBaseline().key} />;
}

function Environments({ report }: { report: JobTimesReport }) {
  const baseline = report.environments.find((env) => env.key === report.baseline);
  return (
    <Baseline
      value={{
        key: report.baseline,
        label: baseline?.label,
        fewRuns: report.fewRuns,
        minSharedJobs: report.minSharedJobs,
      }}
    >
      <DataTable
        caption="Runners"
        columns={environmentColumns}
        data={report.environments}
        getRowId={(env) => env.key}
      />
    </Baseline>
  );
}

function Versus({ env, isBaseline }: { env: EnvironmentSummary; isBaseline: boolean }) {
  if (isBaseline) return <span className="text-muted-foreground">baseline</span>;
  // Too little overlap to say: blank, and the ⓘ explains why.
  if (!env.versus) return null;
  const { ratio, sharedJobs } = env.versus;
  const label = versusLabel(ratio);
  return (
    <>
      <span
        className={cn(
          "font-medium",
          label === "about even"
            ? "text-muted-foreground"
            : ratio < 1
              ? "text-go"
              : "text-destructive",
        )}
      >
        {label}
      </span>
      <span className="ml-2 text-xs text-muted-foreground">on {plural(sharedJobs, "job")}</span>
    </>
  );
}

/** A row of the Workflows table, with its slowest job worked out once. */
type WorkflowsRow = WorkflowRow & { id: string; slowest: { job: JobRow; ms: number } | null };

/** The times of the runner a job ran on most. */
function busiestStat(stats: Stat[]) {
  return stats.reduce<Stat | undefined>(
    (most, stat) => (most && most.samples >= stat.samples ? most : stat),
    undefined,
  );
}

/** The job that usually takes longest, timed on the runner it ran on most. */
function slowestJob(workflow: WorkflowRow) {
  let slowest: WorkflowsRow["slowest"] = null;
  for (const job of workflow.jobs) {
    const ms = busiestStat(Object.values(job.byEnvironment))?.medianMs;
    if (ms != null && ms > (slowest?.ms ?? -1)) slowest = { job, ms };
  }
  return slowest;
}

const [WorkflowsContext, useWorkflowsContext] = createCellContext<{
  showRepository: boolean;
  onOpen: (detail: Detail) => void;
}>("Workflows");

const workflowColumn = dataTableColumns<WorkflowsRow>();
const workflowColumns = workflowColumn.columns([
  workflowColumn.accessor((row) => row.workflow ?? "", {
    id: "workflow",
    header: "Workflow",
    sortFn: "text",
    cell: ({ row }) => <WorkflowCell row={row.original} />,
  }),
  workflowColumn.accessor((row) => row.wall?.runs, {
    id: "runs",
    header: "Runs",
    sortFn: "basic",
    sortDescFirst: true,
    meta: END,
    cell: ({ getValue }) => getValue()?.toLocaleString() ?? "—",
  }),
  workflowColumn.accessor(
    (row) => (row.wall?.runs ? row.wall.successes / row.wall.runs : undefined),
    {
      id: "success",
      header: "Success",
      sortFn: "basic",
      sortDescFirst: true,
      meta: {
        ...END,
        info: <p>The share of finished runs that succeeded. Cancelled runs are left out.</p>,
      },
      cell: ({ getValue }) => {
        const share = getValue();
        return share === undefined ? "—" : `${Math.round(share * 100)}%`;
      },
    },
  ),
  workflowColumn.accessor((row) => row.wall?.medianMs ?? undefined, {
    id: "median",
    header: "Median",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      align: "end",
      className: "font-semibold",
      info: (
        <p>
          From the start of a run to its last job finishing, over successful runs. It includes time
          jobs spent waiting for a runner. Hover a time for its spread.
        </p>
      ),
    },
    cell: ({ row: { original } }) =>
      original.wall ? (
        <span title={spreadText(original.wall)}>{medianText(original.wall)}</span>
      ) : (
        "—"
      ),
  }),
  workflowColumn.accessor((row) => row.wall?.p90Ms ?? undefined, {
    id: "p90",
    header: "p90",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      ...END,
      info: <p>9 in 10 successful runs finished within this. Under 20 runs it's a rough guide.</p>,
    },
    cell: ({ row: { original } }) => (
      <span className={cn(original.wall?.confidence !== "ok" && "text-muted-foreground")}>
        {clock(original.wall?.p90Ms ?? null)}
      </span>
    ),
  }),
  workflowColumn.accessor((row) => row.wall?.trend ?? undefined, {
    id: "trend",
    header: "Trend",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      ...END,
      info: (
        <p>The newer half of the runs against the older half. Red means the workflow got slower.</p>
      ),
    },
    cell: ({ getValue }) => <Trend trend={getValue() ?? null} />,
  }),
  workflowColumn.accessor((row) => row.slowest?.ms, {
    id: "slowest",
    header: "Slowest job",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      className: "whitespace-nowrap",
      info: (
        <p>
          The job that usually takes longest, on the runner it ran on most. Open it to compare
          runners.
        </p>
      ),
    },
    cell: ({ row }) => <SlowestCell row={row.original} />,
  }),
]);

function WorkflowCell({ row }: { row: WorkflowsRow }) {
  const { showRepository } = useWorkflowsContext();
  return (
    <>
      <span className="block font-medium">{row.workflow ?? "Unnamed workflow"}</span>
      <span className="block text-xs text-muted-foreground">
        {showRepository && `${row.repository} · `}
        {plural(row.jobs.length, "job")}
      </span>
    </>
  );
}

function SlowestCell({ row }: { row: WorkflowsRow }) {
  const { onOpen } = useWorkflowsContext();
  if (!row.slowest) return <span className="text-muted-foreground">—</span>;
  const { job, ms } = row.slowest;
  return (
    <button
      type="button"
      onClick={() => onOpen({ workflow: row, job })}
      className="rounded-sm text-left underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {job.name} <span className="text-muted-foreground">{clock(ms)}</span>
    </button>
  );
}

// Memoized: opening the job detail re-renders the page, not this table.
const Workflows = memo(function Workflows({
  workflows,
  showRepository,
  onOpen,
}: {
  workflows: WorkflowRow[];
  showRepository: boolean;
  onOpen: (detail: Detail) => void;
}) {
  const rows = useMemo(
    () =>
      workflows.map((workflow) => ({
        ...workflow,
        id: `${workflow.repositoryId}/${workflow.workflow ?? ""}`,
        slowest: slowestJob(workflow),
      })),
    [workflows],
  );
  const context = useMemo(() => ({ showRepository, onOpen }), [showRepository, onOpen]);
  return (
    <WorkflowsContext value={context}>
      <DataTable
        columns={workflowColumns}
        data={rows}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "runs", desc: true }]}
        empty="No workflows in this repo in the window."
      />
    </WorkflowsContext>
  );
});

/** A row of the Jobs table: a workflow, one of its jobs, or one leg of a matrix job. */
type JobsRow = {
  id: string;
  workflow: WorkflowRow;
  /** Absent on the workflow's own row. */
  job?: JobRow;
  subRows?: JobsRow[];
} & Timings;

type Timings = ReturnType<typeof timings>;

function jobRows(workflows: WorkflowRow[], environments: EnvironmentSummary[]): JobsRow[] {
  return workflows.map((workflow) => {
    const id = `${workflow.repositoryId}/${workflow.workflow ?? ""}`;
    return {
      id,
      workflow,
      // A plain header: times only mean something per job.
      ...timings(environments, {}),
      subRows: workflow.jobs.map((job) => ({
        id: `${id}/${job.name}`,
        workflow,
        job,
        ...timings(environments, job.byEnvironment),
        subRows: job.legs?.map((leg) => ({
          id: `${id}/${job.name}/${leg.name}`,
          workflow,
          job: leg,
          ...timings(environments, leg.byEnvironment),
        })),
      })),
    };
  });
}

/**
 * The runners a job ran on (fastest first), the fastest of them, its quickest median, and the
 * trend of the runner it ran on most.
 */
function timings(environments: EnvironmentSummary[], byEnvironment: Record<string, Stat>) {
  const ran = environments
    .flatMap((env) => {
      const stat = byEnvironment[env.key];
      return stat && stat.samples > 0 ? [{ env, stat }] : [];
    })
    // Under 5 runs is too few to rank, so those go last.
    .sort(
      (a, b) =>
        Number(a.stat.confidence === "few") - Number(b.stat.confidence === "few") ||
        (a.stat.medianMs ?? Infinity) - (b.stat.medianMs ?? Infinity),
    );
  const medians = ran.flatMap(({ stat }) => (stat.medianMs === null ? [] : [stat.medianMs]));
  const busiest = busiestStat(ran.map(({ stat }) => stat));
  return {
    ran,
    best: fastest(byEnvironment),
    median: medians.length ? Math.min(...medians) : undefined,
    trend: busiest?.trend ?? undefined,
  };
}

const [JobsContext, useJobsContext] = createCellContext<{
  showRepository: boolean;
  onOpen: (detail: Detail) => void;
}>("Jobs");

const jobColumn = dataTableColumns<JobsRow>();
const jobColumns = jobColumn.columns([
  jobColumn.accessor((row) => row.job?.name ?? row.workflow.workflow ?? "", {
    id: "name",
    header: "Workflow › job",
    sortFn: "text",
    // Capped so a long job name wraps instead of pushing the runner times across the page.
    meta: { className: "w-80 min-w-56 align-top" },
    cell: ({ row }) => <NameCell row={row} />,
  }),
  jobColumn.accessor("median", {
    header: "Median by runner",
    sortFn: "basic",
    meta: {
      className: "py-2 align-top",
      info: (
        <>
          <p>
            The median of each runner's newest 50 successful runs, fastest first. Medians, not
            averages, so one cold cache doesn't skew a job. Hover a time for its spread.
          </p>
          <ul className="grid gap-1">
            <li>
              <span className="text-go">▲</span> The fastest runner with 5+ runs
            </li>
            <li>
              <span className="text-run">7 runs</span> in amber: 5 to 19 runs, read with care
            </li>
            <li>~0:52 in grey: under 5 runs, never marked fastest</li>
          </ul>
        </>
      ),
    },
    cell: ({ row }) => <MedianCell row={row.original} />,
  }),
  jobColumn.accessor("trend", {
    header: "Trend",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      align: "end",
      className: "w-0 py-2 align-top whitespace-nowrap",
      info: (
        <p>
          The newer half of the runs against the older half, on the runner the job ran on most. Red
          means the job got slower.
        </p>
      ),
    },
    cell: ({ row, getValue }) => row.original.job && <Trend trend={getValue() ?? null} />,
  }),
]);

function NameCell({ row }: { row: DataTableRow<JobsRow> }) {
  const { showRepository, onOpen } = useJobsContext();
  const { workflow, job } = row.original;
  const open = row.getIsExpanded();
  const toggle = row.getToggleExpandedHandler();
  if (!job)
    return (
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-start gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron open={open} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">
          <span className="font-semibold">{workflow.workflow ?? "Unnamed workflow"}</span>{" "}
          <span className="text-xs text-muted-foreground">
            {showRepository && `${workflow.repository} · `}
            {plural(workflow.jobs.length, "job")}
          </span>
        </span>
      </button>
    );
  return (
    <span className={cn("flex items-start gap-1.5", row.depth === 1 ? "pl-6" : "pl-12")}>
      {row.getCanExpand() && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${job.name} legs`}
          onClick={toggle}
          className="mt-0.5 -ml-5.5 shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron open={open} />
        </button>
      )}
      <button
        type="button"
        onClick={() => onOpen({ workflow, job })}
        className="min-w-0 rounded-sm text-left font-medium break-words underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {job.name}
      </button>
      {job.legs && (
        <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">⊞ {job.legs.length}</span>
      )}
    </span>
  );
}

// One stacked line per runner the job actually ran on, fastest first, instead of one column per
// runner: most jobs only run on one or two runners, so a column each was mostly "not run".
function MedianCell({ row: { job, ran, best } }: { row: JobsRow }) {
  if (!job) return null;
  if (ran.length === 0) return <span className="text-muted-foreground">not run</span>;
  const shown = ran.length > SHOWN_RUNNERS + 1 ? ran.slice(0, SHOWN_RUNNERS) : ran;
  const hidden = ran.slice(shown.length);
  return (
    <ul className="grid gap-1">
      {shown.map(({ env, stat }) => (
        <TimeLine key={env.key} env={env} stat={stat} best={best === env.key} />
      ))}
      {hidden.length > 0 && (
        <li
          className="pl-6 text-xs text-muted-foreground"
          title={hidden.map(({ env, stat }) => `${env.label}: ${medianText(stat)}`).join("\n")}
        >
          +{hidden.length} more
        </li>
      )}
    </ul>
  );
}

// Memoized: opening the job detail re-renders the page, not this table.
const Jobs = memo(function Jobs({
  environments,
  workflows,
  showRepository,
  onOpen,
  toolbar,
}: {
  environments: EnvironmentSummary[];
  workflows: WorkflowRow[];
  showRepository: boolean;
  onOpen: (detail: Detail) => void;
  /** The page's filters, sharing a row with Expand all. */
  toolbar: ReactNode;
}) {
  const rows = useMemo(() => jobRows(workflows, environments), [workflows, environments]);
  const allOpen = useMemo(() => Object.fromEntries(rows.map((row) => [row.id, true])), [rows]);
  // Workflows start open and matrix jobs closed, like a spend breakdown.
  const [expanded, setExpanded] = useState<ExpandedState>(allOpen);
  // A new range or repo brings new workflows, which start open too.
  const [openedFor, setOpenedFor] = useState(allOpen);
  if (openedFor !== allOpen) {
    setOpenedFor(allOpen);
    setExpanded(allOpen);
  }
  const anyOpen = expanded === true || Object.values(expanded).some(Boolean);
  const context = useMemo(() => ({ showRepository, onOpen }), [showRepository, onOpen]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {toolbar}
        <Button size="sm" variant="ghost" onClick={() => setExpanded(anyOpen ? {} : allOpen)}>
          {anyOpen ? "Collapse all" : "Expand all"}
        </Button>
      </div>
      <JobsContext value={context}>
        <DataTable
          columns={jobColumns}
          data={rows}
          getRowId={(row) => row.id}
          getSubRows={(row) => row.subRows}
          expanded={expanded}
          onExpandedChange={setExpanded}
          rowClassName={(row) => (row.original.job ? "hover:bg-secondary/30" : "bg-secondary/60")}
          empty="No jobs in this repo in the window."
        />
      </JobsContext>
    </div>
  );
});

function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-4 text-muted-foreground transition-transform",
        open && "rotate-90",
        className,
      )}
    />
  );
}

/** The fastest environment among those with 5+ runs, when at least two qualify. */
function fastest(byEnvironment: Record<string, Stat>) {
  const ranked = Object.entries(byEnvironment)
    .filter(([, stat]) => stat.samples >= 5 && stat.medianMs !== null)
    .sort(([, a], [, b]) => (a.medianMs ?? 0) - (b.medianMs ?? 0));
  return ranked.length >= 2 ? (ranked[0]?.[0] ?? null) : null;
}

/** Runner lines shown per row; the rest fold into "+N more", and the job detail lists them all. */
const SHOWN_RUNNERS = 3;

function TimeLine({ env, stat, best }: { env: EnvironmentSummary; stat: Stat; best: boolean }) {
  const few = stat.confidence === "few";
  return (
    <li
      className="grid grid-cols-[1rem_13rem_3.5rem_6.5rem] items-center gap-x-2"
      title={spreadText(stat)}
    >
      <ProviderMark provider={providerOf(env)} className="size-4 rounded-[4px]" />
      <span className={cn("truncate", few && "text-muted-foreground")}>{env.label}</span>
      <span
        className={cn(
          "text-right font-semibold whitespace-nowrap",
          best && "text-go",
          few && "font-medium text-muted-foreground",
        )}
      >
        {best && (
          <span className="mr-1 align-[1px] text-[9px]" aria-label="fastest">
            ▲
          </span>
        )}
        {medianText(stat)}
      </span>
      <span
        className={cn(
          "text-xs whitespace-nowrap",
          stat.confidence === "low" ? "text-run" : few ? "text-idle" : "text-muted-foreground",
        )}
      >
        {plural(stat.samples, "run")}
      </span>
    </li>
  );
}

function Trend({ trend }: { trend: number | null }) {
  if (trend === null) return <span className="text-muted-foreground">—</span>;
  const pct = Math.round(trend * 100);
  if (Math.abs(pct) < 5) return <span className="text-muted-foreground">±{Math.abs(pct)}%</span>;
  return (
    <span className={cn("font-medium", pct > 0 ? "text-destructive" : "text-go")}>
      {pct > 0 ? "+" : "−"}
      {Math.abs(pct)}%
    </span>
  );
}

function JobDetail({
  detail,
  days,
  environments,
  onClose,
}: {
  detail: Detail;
  days: number;
  environments: EnvironmentSummary[];
  onClose: () => void;
}) {
  const { workflow, job } = detail;
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (authDisabled) {
      setRuns(sampleRuns(job, days));
      return;
    }
    let live = true;
    getJobRuns(days, {
      repositoryId: workflow.repositoryId,
      workflow: workflow.workflow,
      name: job.name,
      matrix: Boolean(job.legs),
    })
      .then((result) => live && setRuns(result.runs))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [workflow, job, days]);

  const used = environments
    .flatMap((env, index) => {
      const stat = job.byEnvironment[env.key];
      return stat ? [{ env, index, stat }] : [];
    })
    .sort((a, b) => (a.stat.medianMs ?? Infinity) - (b.stat.medianMs ?? Infinity));
  const missing = environments.filter((env) => !job.byEnvironment[env.key]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {workflow.workflow ?? "Unnamed workflow"} › {job.name}
          </DialogTitle>
          <DialogDescription>
            {workflow.repository} · last {days} days · each dot is one run
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
          <div className="min-w-0">
            {failed ? (
              <p className="text-sm text-destructive">Couldn't load the runs. Try again.</p>
            ) : runs === null ? (
              <p className="text-sm text-muted-foreground">Loading runs…</p>
            ) : (
              <RunChart
                runs={runs}
                environments={environments}
                medians={job.byEnvironment}
                days={days}
              />
            )}
          </div>
          <div className="grid content-start gap-3 text-sm tabular-nums">
            {used.map(({ env, index, stat }) => (
              <div
                key={env.key}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 border-b pb-3 last:border-0"
              >
                <Swatch index={index} />
                <ProviderLink
                  provider={providerOf(env)}
                  className="flex min-w-0 items-center gap-1.5 self-center"
                  markClassName="size-4 rounded-[4px]"
                >
                  <span className="truncate">{env.label}</span>
                </ProviderLink>
                <span className="text-right font-semibold">{medianText(stat)}</span>
                <span className="col-span-2 col-start-2 text-right text-xs text-muted-foreground">
                  {spreadText(stat)}
                  {stat.waitMs !== null && ` · wait ${clock(stat.waitMs)}`} ·{" "}
                  <span className={cn(stat.confidence === "low" && "text-run")}>
                    {plural(stat.samples, "run")}
                  </span>
                </span>
              </div>
            ))}
            {missing.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Not run on {missing.map((env) => env.label).join(", ")} in this window, so there's
                nothing to compare there yet.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Run time over the window, one dot per run, a dashed median line per runner. Failures are hollow:
// they stop early, so they're left out of the medians.
function RunChart({
  runs,
  environments,
  medians,
  days,
}: {
  runs: JobRun[];
  environments: EnvironmentSummary[];
  /** The job's times, so the lines match the medians shown beside the chart. */
  medians: Record<string, Stat>;
  days: number;
}) {
  if (runs.length === 0)
    return <p className="text-sm text-muted-foreground">No runs in this window.</p>;
  const W = 520;
  const H = 240;
  const left = 44;
  const right = 10;
  const top = 10;
  const bottom = 24;
  const now = Date.now();
  const start = now - days * DAY_MS;
  const maxMs = Math.max(...runs.map((run) => run.completedAt - run.startedAt), 1000);
  const step = niceStep(maxMs / 4);
  const yMax = Math.ceil(maxMs / step) * step;
  const x = (t: number) => left + ((t - start) / (now - start)) * (W - left - right);
  const y = (ms: number) => top + (1 - ms / yMax) * (H - top - bottom);
  const color = (key: string) =>
    environmentColor(
      Math.max(
        0,
        environments.findIndex((env) => env.key === key),
      ),
    );
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Run time of each run over the window"
    >
      {ticks.map((ms) => (
        <g key={ms}>
          <line
            x1={left}
            x2={W - right}
            y1={y(ms)}
            y2={y(ms)}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text
            x={left - 8}
            y={y(ms) + 3.5}
            textAnchor="end"
            className="fill-muted-foreground text-[10px] tabular-nums"
          >
            {clock(ms)}
          </text>
        </g>
      ))}
      <text x={left} y={H - 6} className="fill-muted-foreground text-[10px]">
        {days}d ago
      </text>
      <text x={W - right} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
        now
      </text>
      {runs.map((run) => {
        const ok = run.conclusion === "success";
        const c = color(run.environment);
        return (
          <circle
            key={run.id}
            cx={x(run.completedAt)}
            cy={y(run.completedAt - run.startedAt)}
            r={3}
            fill={ok ? c : "none"}
            fillOpacity={0.85}
            stroke={c}
            strokeWidth={ok ? 0 : 1.2}
          />
        );
      })}
      {Object.entries(medians).map(([key, stat]) =>
        stat.medianMs === null ? null : (
          <line
            key={key}
            x1={left}
            x2={W - right}
            y1={y(stat.medianMs)}
            y2={y(stat.medianMs)}
            stroke={color(key)}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        ),
      )}
    </svg>
  );
}

// 10s, 15s, 30s, 1m, 2m, 5m, 10m, ... so the axis lands on round times.
function niceStep(ms: number) {
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
  return steps.find((step) => step >= ms) ?? 3_600_000;
}

// For local development without an API (auth disabled).
function sampleRuns(job: JobRow, days: number): JobRun[] {
  const now = Date.now();
  let id = 0;
  let seed = 7;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  return Object.entries(job.byEnvironment).flatMap(([environment, stat]) =>
    Array.from({ length: stat.samples }, () => {
      id += 1;
      const completedAt = now - random() * days * DAY_MS;
      const runMs = (stat.medianMs ?? 0) * (0.8 + random() * 0.4);
      return {
        id,
        runId: id,
        runAttempt: 1,
        environment,
        conclusion: random() > 0.95 ? "failure" : "success",
        queuedAt: null,
        startedAt: completedAt - runMs,
        completedAt,
      };
    }),
  );
}
