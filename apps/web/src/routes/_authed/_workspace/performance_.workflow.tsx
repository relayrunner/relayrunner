// One workflow on every runner it has run on, from the runs it already had (routed runs, GitHub's
// own and provider evaluations): every successful run over the range, then a row per runner with
// its median run split into jobs, its cost per run, and each against GitHub's. Opened from a row of
// Performance's Workflows tab (GET /api/job-times/workflow, apps/api/src/workflow-compare.ts).
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronRightIcon, FlaskConicalIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { runnerTitle } from "@/components/performance-workflows";
import { ProviderMark, providerOf, RunnerMark } from "@/components/providers";
import { TimeRangePicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ChartSeries, WorkflowRunsChart } from "@/components/workflow-runs-chart";
import { authDisabled } from "@/lib/auth-client";
import { useFlag } from "@/lib/flags";
import {
  clock,
  environmentColor,
  getWorkflowReport,
  JOB_RANGES,
  plural,
  runCost,
  type WorkflowReport,
  type WorkflowRunner,
} from "@/lib/job-times";
import { providerInfo } from "@/lib/provider-catalog";
import { rangeSearch, textParam, useRangeReport, useSetSearch } from "@/lib/search-params";
import { rangeDays, rangePhrase, resolveRange, type TimeRange } from "@/lib/time-range";
import { cn } from "@/lib/utils";
import { sampleWorkflowReport } from "@/lib/workflow-sample";

const DEFAULT_RANGE: TimeRange = "14d";
const ranges = rangeSearch(JOB_RANGES, DEFAULT_RANGE);

/** Runners the chart shows at first: the baseline and the busiest others. */
const CHARTED = 4;
/** Providers listed under "Not tried" before "Show more". */
const UNTRIED_SHOWN = 3;

// `repo` and `workflow` name it (no `workflow` for one GitHub didn't name). `metric=cost` charts
// cost per run instead of time, `metric=wait` the wait for a runner; `job` charts one job instead
// of the whole run.
type Search = {
  repo: number;
  workflow?: string;
  range?: TimeRange;
  metric?: "cost" | "wait";
  job?: string;
};

const validateSearch = (search: Record<string, unknown>): Search => {
  const repo = Number(search.repo);
  return {
    repo: Number.isSafeInteger(repo) && repo > 0 ? repo : 0,
    workflow: textParam(search.workflow),
    ...ranges.validateSearch(search),
    metric: search.metric === "cost" || search.metric === "wait" ? search.metric : undefined,
    job: textParam(search.job),
  };
};

function load(search: Search, range: TimeRange): Promise<WorkflowReport | null> {
  const ref = { repositoryId: search.repo, workflow: search.workflow ?? null };
  if (authDisabled)
    return Promise.resolve(sampleWorkflowReport(rangeDays(range), ref.repositoryId, ref.workflow));
  if (!ref.repositoryId) return Promise.resolve(null);
  // Not found: no runs of it in the range.
  return getWorkflowReport(range, ref).catch((error: { status?: number }) => {
    if (error.status === 404) return null;
    throw error;
  });
}

export const Route = createFileRoute("/_authed/_workspace/performance_/workflow")({
  validateSearch,
  loaderDeps: ({ search: { repo, workflow } }) => ({ repo, workflow }),
  loader: ({ location }) => {
    const search = validateSearch(location.search);
    return load(search, ranges.rangeOf(search));
  },
  // A new range loads in the page, and the toggles change only the chart.
  shouldReload: ({ cause }) => cause !== "stay",
  component: WorkflowPage,
});

// The job picker's value for the whole run, which no job is named.
const WHOLE = "\u0000whole";

function WorkflowPage() {
  const search = Route.useSearch();
  const range = ranges.rangeOf(search);
  const setSearch = useSetSearch<Search>();
  const report = useRangeReport<WorkflowReport | null, TimeRange>(
    Route.useLoaderData(),
    range,
    (next) => load(search, next),
  );
  const title = search.workflow ?? report?.workflow ?? "Unnamed workflow";

  return (
    <section>
      <Link
        to="/performance"
        search={{ range: search.range }}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon aria-hidden className="size-3.5" />
        Performance
      </Link>
      <PageHeader title={title}>
        {report
          ? `${report.repository} · ${plural(report.jobs.length, "job")}. How each runner it has used compares, from the runs it already had.`
          : "How each runner this workflow has used compares, from the runs it already had."}
      </PageHeader>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <TimeRangePicker
            {...JOB_RANGES}
            value={range}
            onChange={(next) => setSearch(ranges.toSearch(next))}
          />
        </div>
        {report === null ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            No runs of this workflow in {rangePhrase(range)}. Try a longer range.
          </p>
        ) : (
          <SectionBoundary>
            <Comparison report={report} range={range} />
          </SectionBoundary>
        )}
      </div>
    </section>
  );
}

function Comparison({ report, range }: { report: WorkflowReport; range: TimeRange }) {
  const search = Route.useSearch();
  const setSearch = useSetSearch<Search>();
  const job = search.job && report.jobs.includes(search.job) ? search.job : null;
  const metric = search.metric ?? "time";
  const colors = useMemo(
    () => new Map(report.runners.map((runner, index) => [runner.key, environmentColor(index)!])),
    [report],
  );
  const [charted, setCharted] = useState<Set<string>>(() => firstCharted(report));
  const series: ChartSeries[] = report.runners
    .filter((runner) => charted.has(runner.key))
    .map((runner) => ({
      key: runner.key,
      name: runnerTitle(runner),
      color: colors.get(runner.key)!,
    }));
  const missing = series.filter((each) =>
    job ? !report.runners.find((runner) => runner.key === each.key)?.jobs[job] : false,
  );
  const { from, to } = resolveRange(range);
  const toggle = (key: string) =>
    setCharted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <Card className="gap-0 p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">
              {job ?? report.workflow ?? "Unnamed workflow"} over {rangePhrase(range)}
            </h2>
            <p className="text-sm text-muted-foreground">
              {metric === "cost"
                ? "Each dot is one passing run's cost at list prices. Lines join each runner's daily median."
                : metric === "wait"
                  ? job
                    ? "Each dot is how long this job waited for a runner. Lines join each runner's daily median."
                    : "Each dot is the longest any job of one passing run waited for a runner. Lines join each runner's daily median."
                  : "Each dot is one passing run. Lines join each runner's daily median, and break where it took no runs."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={job ?? WHOLE}
              onValueChange={(next) => setSearch({ job: next === WHOLE ? undefined : next })}
            >
              <SelectTrigger size="sm" aria-label="Job">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={WHOLE}>Whole workflow</SelectItem>
                {report.jobs.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div
              role="group"
              aria-label="Show"
              className="inline-flex rounded-md bg-raised-2 p-0.5 text-sm"
            >
              {(
                [
                  ["Time", undefined],
                  ["Waiting", "wait"],
                  ["Cost per run", "cost"],
                ] as const
              ).map(([label, value]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={search.metric === value}
                  onClick={() => setSearch({ metric: value })}
                  className={cn(
                    "rounded-[5px] px-2.5 py-0.5 whitespace-nowrap",
                    search.metric === value
                      ? "bg-card font-medium shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((each) => (
              <span key={each.key} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className="inline-block h-0.5 w-3 rounded"
                  style={{ background: each.color }}
                />
                {each.name}
              </span>
            ))}
            {report.runs.some((run) => run.evaluation) && (
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="inline-block size-2.5 rounded-full border-2 border-muted-foreground" />
                Evaluation run
              </span>
            )}
            {missing.map((each) => (
              <span key={each.key} className="whitespace-nowrap">
                {each.name} didn't run {job}
              </span>
            ))}
          </div>
        </div>
        <WorkflowRunsChart
          runs={report.runs}
          series={series}
          job={job}
          metric={metric}
          from={from}
          to={to}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {job
            ? "Each runner's runs of this job, wherever the rest of the run went."
            : "Runs that ran every job on one runner. Check runners below to chart them."}
        </p>
      </Card>
      <Runners report={report} colors={colors} charted={charted} onToggle={toggle} />
    </>
  );
}

function firstCharted(report: WorkflowReport) {
  const keys = report.runners.filter((runner) => runner.wholeRuns > 0).map((runner) => runner.key);
  const first = new Set(keys.slice(0, CHARTED));
  if (report.baseline && keys.includes(report.baseline)) {
    first.add(report.baseline);
    if (first.size > CHARTED)
      first.delete(keys.filter((key) => key !== report.baseline)[CHARTED - 1]!);
  }
  return first;
}

/**
 * "44 runs", or "5 eval" for a runner that has only been evaluated, so nobody takes trial runs for
 * routed CI. Once a runner takes real runs, its evaluations stop being worth calling out.
 */
function RunsText({ runner }: { runner: WorkflowRunner }) {
  if (runner.runs > 0) return <span>{plural(runner.runs, "run")}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <FlaskConicalIcon aria-hidden className="size-3" />
      {runner.evaluations} eval
    </span>
  );
}

function Runners({
  report,
  colors,
  charted,
  onToggle,
}: {
  report: WorkflowReport;
  colors: Map<string, string>;
  charted: Set<string>;
  onToggle: (key: string) => void;
}) {
  const evaluate = useFlag("provider-evaluations");
  const [open, setOpen] = useState<string | null>(null);
  const [allUntried, setAllUntried] = useState(false);
  const rows = report.runners.toSorted(
    (a, b) => (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity),
  );
  const spreads = useMemo(() => runnerSpreads(report), [report]);
  // One scale for every row, so the ranges line up against each other.
  const maxMs =
    Math.max(
      ...[...spreads.values()].flatMap((each) => [
        each.whole?.hi ?? 0,
        ...[...each.jobs.values()].map((job) => job.hi),
      ]),
      1,
    ) * 1.05;
  // Live providers only, the ones people know first.
  const untried = report.untried
    .map((id) => providerInfo(id))
    .filter((provider) => provider.status === "live")
    .sort((a, b) => Number(b.featured) - Number(a.featured));
  const shownUntried = allUntried ? untried : untried.slice(0, UNTRIED_SHOWN);

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
        <h2 className="font-semibold">Runners</h2>
        <span className="text-xs text-muted-foreground">
          {plural(rows.length, "runner")} ran this workflow
          {untried.length > 0 && ` · ${untried.length} not tried yet`}
        </span>
      </div>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="border-y text-left text-xs whitespace-nowrap text-muted-foreground">
            <th className="w-10 px-4 py-2">
              <span className="sr-only">Chart</span>
            </th>
            <th className="px-2 py-2 font-medium">Runner</th>
            <th className="w-[36%] min-w-56 px-4 py-2 font-medium">
              <span className="inline-flex items-center gap-1.5">
                Run time
                <InfoTip label="Run time">
                  <p>
                    The number is the median run. The bar shows where most runs fall, and the tick
                    marks the median.
                  </p>
                </InfoTip>
              </span>
            </th>
            <th className="px-4 py-2 text-right font-medium">
              <span className="inline-flex items-center gap-1.5">
                Waiting
                <InfoTip label="Waiting">
                  <p>The median time a job waited for this runner to pick it up.</p>
                </InfoTip>
              </span>
            </th>
            <th className="px-4 py-2 text-right font-medium">Cost per run</th>
            <th className="px-4 py-2 text-right font-medium">Runs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((runner) => (
            <RunnerRow
              key={runner.key}
              runner={runner}
              report={report}
              color={colors.get(runner.key)!}
              charted={charted.has(runner.key)}
              onToggle={() => onToggle(runner.key)}
              open={open === runner.key}
              onOpen={() => setOpen(open === runner.key ? null : runner.key)}
              maxMs={maxMs}
              spread={spreads.get(runner.key)!}
            />
          ))}
          {untried.length > 0 && (
            <>
              <tr className="border-b bg-raised-2/30 text-xs text-muted-foreground">
                <td />
                <td colSpan={5} className="px-2 py-2 font-medium">
                  Not tried on this workflow
                </td>
              </tr>
              {shownUntried.map((provider) => (
                <tr key={provider.id} className="border-b text-muted-foreground last:border-0">
                  <td className="px-4 py-3">
                    <span aria-hidden className="block size-4 rounded-[4px] border border-dashed" />
                  </td>
                  <td className="px-2 py-3">
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <span className="size-3.5" />
                      <ProviderMark provider={provider.id} className="size-5 rounded-[5px]" />
                      <span className="font-medium text-foreground">{provider.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">No runs yet</td>
                  <td className="px-4 py-3 text-right">—</td>
                  <td className="px-4 py-3 text-right">—</td>
                  <td className="px-4 py-2 text-right">
                    {evaluate && (
                      <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" asChild>
                        <Link to="/providers/$provider/evaluate" params={{ provider: provider.id }}>
                          <FlaskConicalIcon aria-hidden className="size-3.5" />
                          Evaluate
                        </Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {untried.length > UNTRIED_SHOWN && (
                <tr>
                  <td />
                  <td colSpan={5} className="px-2 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => setAllUntried(!allUntried)}
                    >
                      {allUntried ? "Show fewer" : `Show ${untried.length - UNTRIED_SHOWN} more`}
                    </Button>
                  </td>
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RunnerRow({
  runner,
  report,
  color,
  charted,
  onToggle,
  open,
  onOpen,
  maxMs,
  spread,
}: {
  runner: WorkflowRunner;
  report: WorkflowReport;
  color: string;
  charted: boolean;
  onToggle: () => void;
  open: boolean;
  onOpen: () => void;
  maxMs: number;
  spread: RunnerSpread;
}) {
  const few = runner.wholeRuns > 0 && runner.wholeRuns < report.fewRuns;
  const jobs = report.jobs.map((name) => ({ name, stat: runner.jobs[name] ?? null }));
  const spec = runnerSpecText(runner);
  return (
    <Fragment>
      <tr className={cn("border-b", !charted && "text-muted-foreground", open && "border-b-0")}>
        <td className="px-4 py-3">
          <input
            type="checkbox"
            checked={charted}
            onChange={onToggle}
            aria-label={`Chart ${runnerTitle(runner)}`}
            className="block size-4 cursor-pointer rounded-[4px]"
            style={{ accentColor: color }}
          />
        </td>
        <td className="px-2 py-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={onOpen}
            className="flex items-center gap-2 rounded-sm text-left whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <RunnerMark runner={runner} className="size-5 rounded-[5px]" />
            <span className={cn("font-medium", charted && "text-foreground")}>
              {runnerTitle(runner)}
            </span>
            {spec && <span className="text-xs text-muted-foreground">{spec}</span>}
          </button>
        </td>
        <td className="px-4 py-3">
          {/* Laid out like the job rows, so every track shares one scale and one left edge. */}
          <span className="flex items-center gap-4">
            <span
              className={cn(
                "w-12 shrink-0 font-medium whitespace-nowrap",
                charted && "text-foreground",
              )}
            >
              {runner.medianMs === null ? "—" : `${few ? "~" : ""}${clock(runner.medianMs)}`}
            </span>
            {/* A runner that only ran some jobs has no whole-run time, so the dash stands alone. */}
            {runner.medianMs !== null && (
              <RangeBar
                range={spread.whole}
                max={maxMs}
                color={color}
                faded={!charted}
                className="flex-1"
              />
            )}
          </span>
        </td>
        <td className="px-4 py-3 text-right whitespace-nowrap text-muted-foreground">
          {spread.waitMs === null ? "—" : clock(spread.waitMs)}
        </td>
        <td
          className={cn(
            "px-4 py-3 text-right font-medium whitespace-nowrap",
            charted && "text-foreground",
          )}
        >
          {runCost(runner.usd)}
        </td>
        <td className="px-4 py-3 text-right text-xs whitespace-nowrap text-muted-foreground">
          <RunsText runner={runner} />
        </td>
      </tr>
      {open &&
        jobs.map(({ name, stat }, index) => {
          const waitMs = spread.jobWaits.get(name) ?? null;
          return (
            <tr
              key={name}
              className={cn("bg-raised-2/30 text-[13px]", index === jobs.length - 1 && "border-b")}
            >
              <td />
              <td className="py-1.5 pr-2 pl-12 whitespace-nowrap text-muted-foreground">{name}</td>
              <td className="px-4 py-1.5">
                {stat?.medianMs == null ? (
                  <span className="text-muted-foreground">Not run here</span>
                ) : (
                  <span className="flex items-center gap-4">
                    <span className="w-12 shrink-0 whitespace-nowrap">{clock(stat.medianMs)}</span>
                    <RangeBar
                      range={spread.jobs.get(name) ?? null}
                      max={maxMs}
                      // Gray, so the runner rows keep the only color.
                      color="var(--muted-foreground)"
                      faded={!charted}
                      small
                      className="flex-1"
                    />
                  </span>
                )}
              </td>
              <td className="px-4 py-1.5 text-right whitespace-nowrap text-muted-foreground">
                {waitMs === null ? "—" : clock(waitMs)}
              </td>
              <td className="px-4 py-1.5 text-right whitespace-nowrap text-muted-foreground">
                {runCost(stat?.usd)}
              </td>
              <td className="px-4 py-1.5 text-right text-xs whitespace-nowrap text-muted-foreground">
                {stat && plural(stat.runs, "run")}
              </td>
            </tr>
          );
        })}
    </Fragment>
  );
}

/** Most of a runner's runs (10th to 90th percentile) and their median, in ms. */
type Range = { lo: number; mid: number; hi: number };
/** A runner's run time spreads, and the median wait of its jobs (all, and by job name). */
type RunnerSpread = {
  whole: Range | null;
  jobs: Map<string, Range>;
  waitMs: number | null;
  jobWaits: Map<string, number>;
};

function quantile(sorted: number[], q: number) {
  const at = (sorted.length - 1) * q;
  const below = Math.floor(at);
  return sorted[below]! + (sorted[Math.ceil(at)]! - sorted[below]!) * (at - below);
}

function rangeOf(values: number[]): Range | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return { lo: quantile(sorted, 0.1), mid: quantile(sorted, 0.5), hi: quantile(sorted, 0.9) };
}

/**
 * Each runner's spread of successful runs that ran every job there, and each job's spread.
 */
function runnerSpreads(report: WorkflowReport) {
  const spreads = new Map<string, RunnerSpread>();
  for (const runner of report.runners) {
    const whole = report.runs.filter((run) => run.environment === runner.key).map((run) => run.ms);
    const jobs = new Map<string, Range>();
    for (const name of report.jobs) {
      const range = rangeOf(
        report.runs.flatMap((run) =>
          run.jobs
            .filter((job) => job.name === name && job.environment === runner.key)
            .map((job) => job.ms),
        ),
      );
      if (range) jobs.set(name, range);
    }
    const waits = (name?: string) =>
      rangeOf(
        report.runs.flatMap((run) =>
          run.jobs.flatMap((job) =>
            job.environment === runner.key &&
            (name === undefined || job.name === name) &&
            job.waitMs !== null
              ? [job.waitMs]
              : [],
          ),
        ),
      )?.mid ?? null;
    const jobWaits = new Map<string, number>();
    for (const name of report.jobs) {
      const wait = waits(name);
      if (wait !== null) jobWaits.set(name, wait);
    }
    spreads.set(runner.key, { whole: rangeOf(whole), jobs, waitMs: waits(), jobWaits });
  }
  return spreads;
}

/** A track on the table's shared scale: a soft bar over most runs, a tick at the median. */
function RangeBar({
  range,
  max,
  color,
  faded,
  small = false,
  className,
}: {
  range: Range | null;
  max: number;
  color: string;
  faded: boolean;
  small?: boolean;
  className?: string;
}) {
  const at = (ms: number) => `${Math.min(ms / max, 1) * 100}%`;
  return (
    <span
      className={cn("relative flex items-center", small ? "h-3" : "h-4", className)}
      title={
        range
          ? `Most runs ${clock(range.lo)}–${clock(range.hi)} · median ${clock(range.mid)}`
          : undefined
      }
    >
      <span className={cn("w-full rounded-full bg-raised-2", small ? "h-1.5" : "h-2")} />
      {range && (
        <>
          <span
            className={cn("absolute rounded-full", small ? "h-1.5" : "h-2")}
            style={{
              left: at(range.lo),
              width: `max(6px, calc(${at(range.hi)} - ${at(range.lo)}))`,
              background: color,
              opacity: faded ? 0.2 : 0.4,
            }}
          />
          <span
            className={cn("absolute w-[3px] -translate-x-1/2 rounded-full", small ? "h-3" : "h-4")}
            style={{ left: at(range.mid), background: color, opacity: faded ? 0.5 : 1 }}
          />
        </>
      )}
    </span>
  );
}

/** "4 vCPU": what tells two runners of one provider apart. A machine's name says enough. */
function runnerSpecText(runner: WorkflowRunner) {
  if (providerOf(runner) === "machine") return null;
  if (runner.size) return `${runner.size.vcpus} vCPU`;
  // A cloud runner named by its provider: its label says which one.
  return runnerTitle(runner) === runner.label ? null : runner.label;
}
