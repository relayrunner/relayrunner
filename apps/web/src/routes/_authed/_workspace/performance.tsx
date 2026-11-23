import { createFileRoute } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { PageTabs, type Tab, viewOf } from "@/components/page-tabs";
import { JobTypes } from "@/components/job-type-time";
import { PerformanceWorkflows } from "@/components/performance-workflows";
import { RunnerLink } from "@/components/runner-link";
import { sizeText } from "@relayrunner/providers";
import { byProvider, ProviderMark, providerStyle } from "@/components/providers";
import { TimeRangePicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
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
  niceStep,
  plural,
  type RunStep,
  type Stat,
  EMPTY_STAT,
  JOB_RANGES,
  p90Text,
  versusLabel,
  type WorkflowRow,
} from "@/lib/job-times";
import {
  rangeSearch,
  textParam,
  unlessDefault,
  useRangeReport,
  useSetSearch,
} from "@/lib/search-params";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { rangeDays, rangeName, rangePhrase, resolveRange, type TimeRange } from "@/lib/time-range";
import { shortDate } from "@/lib/time-zone";
import { cn } from "@/lib/utils";
import { Count } from "@/components/count";
import { RunSteps } from "@/components/job-phases";

const DEFAULT_RANGE: TimeRange = "14d";
const ranges = rangeSearch(JOB_RANGES, DEFAULT_RANGE);

// Whether the Runners tab groups runners by provider, kept per browser.
const GROUPED_KEY = "relayrunner:performance:by-provider";

// An old link's `?view=jobs` lands on Workflows, whose rows open each workflow's jobs.
const TABS = [
  { value: "workflows", label: "Workflows" },
  { value: "runners", label: "Runners" },
  { value: "types", label: "Job types" },
] as const satisfies Tab<string>[];
type View = (typeof TABS)[number]["value"];

// `range` and `repos` (a repo's full name) narrow every tab. `repo`, `workflow` and `job` open one
// job's detail, for links from a job's panel.
type Search = {
  view?: View;
  range?: TimeRange;
  repos?: string;
  repo?: number;
  workflow?: string;
  job?: string;
};
const validateSearch = (search: Record<string, unknown>): Search => {
  const repo = Number(search.repo);
  return {
    view: viewOf(TABS, search.view),
    ...ranges.validateSearch(search),
    repos: textParam(search.repos),
    repo: Number.isSafeInteger(repo) && repo > 0 ? repo : undefined,
    workflow: textParam(search.workflow),
    job: textParam(search.job),
  };
};

export const Route = createFileRoute("/_authed/_workspace/performance")({
  validateSearch,
  loader: ({ location }) => getJobTimes(ranges.rangeOf(validateSearch(location.search))),
  // Every tab reads the same report, so switching tabs doesn't load it again, and a new range
  // loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: PerformancePage,
});

type Detail = { workflow: WorkflowRow; job: JobRow };

/** The job a link names, or a matrix job one of whose legs it names. */
function linkedDetail(workflows: WorkflowRow[], search: Search): Detail | null {
  if (search.repo === undefined || !search.job) return null;
  const workflow = workflows.find(
    (each) => each.repositoryId === search.repo && (each.workflow ?? undefined) === search.workflow,
  );
  const job =
    workflow?.jobs.find((each) => each.name === search.job) ??
    workflow?.jobs.find((each) => each.legs?.some((leg) => leg.name === search.job));
  return workflow && job ? { workflow, job } : null;
}

function PerformancePage() {
  const search = Route.useSearch();
  const view = search.view ?? "workflows";
  const range = ranges.rangeOf(search);
  const repository = search.repos ?? "all";
  const setSearch = useSetSearch<Search>();
  const report: JobTimesReport = useRangeReport(Route.useLoaderData(), range, getJobTimes);
  const [grouped, setGrouped] = useState(() => readFlag(GROUPED_KEY));
  const detail = useMemo(() => linkedDetail(report.workflows, search), [report, search]);
  function closeDetail() {
    setSearch({ repo: undefined, workflow: undefined, job: undefined });
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

  const filters = (
    <div className="flex flex-wrap items-center gap-3">
      <TimeRangePicker
        {...JOB_RANGES}
        value={range}
        onChange={(next) => setSearch(ranges.toSearch(next))}
      />
      {repositories.length > 1 && (
        <Select
          value={repository}
          onValueChange={(next) => setSearch({ repos: unlessDefault(next, "all") })}
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
      {view === "runners" && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={grouped}
          className={cn("ml-auto", !grouped && "text-muted-foreground")}
          onClick={() => {
            saveFlag(GROUPED_KEY, !grouped);
            setGrouped(!grouped);
          }}
        >
          <LayersIcon aria-hidden />
          Group by provider
        </Button>
      )}
    </div>
  );

  return (
    <TooltipProvider>
      <section>
        <PageHeader title="Performance">
          How long each workflow takes and what it costs, on every runner it has used. Open one to
          compare its runners. Times come from successful runs, so failures that stop early don't
          skew them.
        </PageHeader>
        <PageTabs tabs={TABS} value={view} />
        <div className="grid gap-6">
          {filters}
          {report.environments.length === 0 ? (
            <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
              No finished jobs in {rangePhrase(range)}. Jobs show up here once the GitHub App sees
              them run in a connected repo.
            </p>
          ) : (
            <SectionBoundary>
              {view === "types" ? (
                <JobTypes range={range} repository={repository} />
              ) : view === "runners" ? (
                <Environments report={report} grouped={grouped} />
              ) : (
                <PerformanceWorkflows
                  report={report}
                  workflows={workflows}
                  showRepository={showRepository}
                  range={range}
                />
              )}
            </SectionBoundary>
          )}
        </div>
        {detail && (
          <SectionBoundary>
            <JobDetail
              detail={detail}
              range={range}
              environments={report.environments}
              onClose={closeDetail}
            />
          </SectionBoundary>
        )}
      </section>
    </TooltipProvider>
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

/** A runner's row, or with `group` a provider's, holding its runners as subRows. */
type EnvironmentRow = EnvironmentSummary & {
  group?: string;
  subRows?: EnvironmentRow[];
};

const environmentColumn = dataTableColumns<EnvironmentRow>();
const environmentColumns = environmentColumn.columns([
  environmentColumn.accessor("label", {
    header: "Runner",
    sortFn: "text",
    cell: ({ row: { original: env, depth } }) => {
      if (env.group)
        return (
          <span className="flex items-center gap-2.5 font-semibold">
            <ProviderMark provider={env.group} />
            {env.label}
            <span className="text-xs font-normal text-muted-foreground">
              {plural(env.subRows?.length ?? 0, "runner")}
            </span>
          </span>
        );
      const detail = [env.detail, sizeText(env.size)].filter(Boolean);
      return (
        <RunnerLink
          runner={env}
          specsShown
          className={cn("flex w-fit items-center gap-2.5", depth > 0 && "ml-7.5")}
        >
          <span>
            <span className="block whitespace-nowrap">{env.label}</span>
            {detail.length > 0 && (
              // On a phone the size can wrap under the machine, but neither breaks inside.
              <span className="block text-xs text-muted-foreground">
                {detail.map((part, index) => (
                  <Fragment key={part}>
                    {index > 0 && " · "}
                    <span className="whitespace-nowrap">{part}</span>
                  </Fragment>
                ))}
              </span>
            )}
          </span>
        </RunnerLink>
      );
    },
  }),
  environmentColumn.accessor((env) => env.stat.runs, {
    id: "jobs",
    header: "Jobs",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...END, hideOnPhone: true },
    cell: ({ getValue }) => <Count value={getValue()} />,
  }),
  environmentColumn.accessor(
    (env) => {
      const sent = env.stat.runs + env.missed;
      return sent ? env.stat.runs / sent : undefined;
    },
    {
      id: "started",
      header: "Started",
      sortFn: "basic",
      meta: {
        ...END,
        hideOnPhone: true,
        info: (
          <>
            <p>The share of jobs sent to this runner that it picked up.</p>
            <p>
              A job counts as missed when it waited 10 minutes and no runner took it. Failing tests
              don't count against it.
            </p>
          </>
        ),
      },
      cell: ({ getValue, row }) => {
        const share = getValue();
        if (share === undefined) return "—";
        const { missed } = row.original;
        return (
          <span title={missed ? `${plural(missed, "job")} not picked up` : undefined}>
            {`${Math.floor(share * 100)}%`}
          </span>
        );
      },
    },
  ),
  environmentColumn.accessor((env) => env.stat.waitMs ?? undefined, {
    id: "wait",
    header: "Median wait",
    sortFn: "basic",
    meta: {
      ...END,
      hideOnPhone: true,
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
  environmentColumn.accessor((env) => env.stat.p90Ms ?? undefined, {
    id: "p90",
    header: "p90 run",
    sortFn: "basic",
    meta: {
      ...END,
      hideOnPhone: true,
      info: <p>9 in 10 successful jobs on this runner finished within this.</p>,
    },
    cell: ({ row }) => <P90 stat={row.original.stat} />,
  }),
  environmentColumn.accessor(
    (env) => (env.stat.runs ? env.stat.successes / env.stat.runs : undefined),
    {
      id: "success",
      header: "Success",
      sortFn: "basic",
      sortDescFirst: true,
      meta: { ...END, hideOnPhone: true },
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
    meta: {
      className: "whitespace-nowrap",
      hideOnPhone: true,
      info: <VersusInfo />,
      label: "Vs. baseline",
    },
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

function Environments({ report, grouped }: { report: JobTimesReport; grouped: boolean }) {
  const baseline = report.environments.find((env) => env.key === report.baseline);
  const rows = useMemo(
    (): EnvironmentRow[] => (grouped ? groupRows(report.environments) : report.environments),
    [report.environments, grouped],
  );
  const expanded = useMemo(() => Object.fromEntries(rows.map((row) => [row.key, true])), [rows]);
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
        columns={environmentColumns}
        data={rows}
        getRowId={(env) => env.key}
        getSubRows={(env) => env.subRows}
        expanded={grouped ? expanded : undefined}
        rowClassName={(row) => (row.original.group ? "bg-muted/40 hover:bg-muted/40" : undefined)}
      />
    </Baseline>
  );
}

/**
 * Runners under a row per provider, busiest provider first. A provider's row adds up its runners'
 * jobs and successes; medians don't add up, so it leaves the times blank.
 */
function groupRows(environments: EnvironmentSummary[]): EnvironmentRow[] {
  return byProvider(environments).map(([provider, envs]) => ({
    key: `provider:${provider}`,
    label: providerStyle(provider).name,
    detail: "",
    group: provider,
    stat: {
      ...EMPTY_STAT,
      runs: envs.reduce((sum, env) => sum + env.stat.runs, 0),
      successes: envs.reduce((sum, env) => sum + env.stat.successes, 0),
    },
    missed: envs.reduce((sum, env) => sum + env.missed, 0),
    versus: null,
    subRows: envs,
  }));
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

/** A p90, faint under 20 runs, where it's a rough guide. */
function P90({ stat }: { stat: Stat | null | undefined }) {
  return (
    <span className={cn(stat?.confidence !== "ok" && "text-muted-foreground")}>
      {clock(stat?.p90Ms ?? null)}
    </span>
  );
}

/**
 * How many runs a time comes from. Under 20 it reads "only 7 runs", with a tooltip on what that
 * means for the time.
 */
function RunCount({ stat, className }: { stat: Stat; className?: string }) {
  const count = plural(stat.samples, "run");
  if (stat.confidence !== "low" && stat.confidence !== "few")
    return (
      <span className={cn("text-xs whitespace-nowrap text-muted-foreground", className)}>
        {count}
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "cursor-help text-xs whitespace-nowrap text-muted-foreground underline decoration-dotted underline-offset-2",
            className,
          )}
        >
          only {count}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 font-normal">
        {stat.confidence === "few"
          ? "Too few runs to compare, so this runner is never marked fastest."
          : "A rough guide until there are 20 runs."}
      </TooltipContent>
    </Tooltip>
  );
}

function JobDetail({
  detail,
  range,
  environments,
  onClose,
}: {
  detail: Detail;
  range: TimeRange;
  environments: EnvironmentSummary[];
  onClose: () => void;
}) {
  const { workflow, job } = detail;
  const [result, setResult] = useState<{ runs: JobRun[]; steps: RunStep[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (authDisabled) {
      setResult({ runs: sampleRuns(job, rangeDays(range)), steps: sampleSteps(job) });
      return;
    }
    let live = true;
    getJobRuns(range, {
      repositoryId: workflow.repositoryId,
      workflow: workflow.workflow,
      name: job.name,
      matrix: Boolean(job.legs),
    })
      .then((next) => live && setResult(next))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [workflow, job, range]);

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
            {workflow.repository} · {rangeName(range)} · each dot is one run
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
          <div className="min-w-0">
            {failed ? (
              <p className="text-sm text-destructive">Couldn't load the runs. Try again.</p>
            ) : result === null ? (
              <p className="text-sm text-muted-foreground">Loading runs…</p>
            ) : (
              <RunChart
                runs={result.runs}
                environments={environments}
                medians={job.byEnvironment}
                range={range}
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
                <RunnerLink
                  runner={env}
                  className="flex min-w-0 items-center gap-1.5 self-center"
                  markClassName="size-4 rounded-[4px]"
                >
                  <span className="truncate">{env.label}</span>
                </RunnerLink>
                <span className="text-right font-semibold">{medianText(stat)}</span>
                <span className="col-span-2 col-start-2 text-right text-xs text-muted-foreground">
                  {p90Text(stat)}
                  {stat.waitMs !== null && ` · wait ${clock(stat.waitMs)}`} ·{" "}
                  <RunCount stat={stat} />
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
        {result && <RunSteps steps={result.steps} />}
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
  range,
}: {
  runs: JobRun[];
  environments: EnvironmentSummary[];
  /** The job's times, so the lines match the medians shown beside the chart. */
  medians: Record<string, Stat>;
  range: TimeRange;
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
  const { from: start, to: end } = resolveRange(range, now);
  const maxMs = Math.max(...runs.map((run) => run.completedAt - run.startedAt), 1000);
  const step = niceStep(maxMs / 4);
  const yMax = Math.ceil(maxMs / step) * step;
  const x = (t: number) => left + ((t - start) / (end - start)) * (W - left - right);
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
        {shortDate(start)}
      </text>
      <text x={W - right} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
        {end === now ? "now" : shortDate(end - 1)}
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

// For local development without an API: a typical Node job's steps, scaled to its median.
function sampleSteps(job: JobRow): RunStep[] {
  const medianMs = Object.values(job.byEnvironment)[0]?.medianMs ?? 180_000;
  const steps: [string, RunStep["phase"], number][] = [
    ["Set up job", "setup", 0.03],
    ["Run actions/checkout@v4", "checkout", 0.04],
    ["Run pnpm/action-setup@v4", "setup", 0.02],
    ["Run actions/setup-node@v4", "setup", 0.09],
    ["Run pnpm install --frozen-lockfile", "dependencies", 0.18],
    ["Run pnpm build", "work", 0.22],
    ["Run pnpm test", "work", 0.34],
    ["Post Run actions/setup-node@v4", "cache", 0.07],
    ["Post Run actions/checkout@v4", "cleanup", 0.002],
    ["Complete job", "cleanup", 0.003],
  ];
  return steps.map(([name, phase, share]) => ({ name, phase, ms: Math.round(medianMs * share) }));
}
