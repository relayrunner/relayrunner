// One workflow on every runner it has run on, from the runs it already had (routed runs, GitHub's
// own and provider evaluations): every successful run over the range, then a row per runner with
// its median run split into jobs, its cost per run, and each against GitHub's. Opened from a row of
// Performance's Workflows tab (GET /api/job-times/workflow, apps/api/src/workflow-compare.ts).
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronRightIcon, FlaskConicalIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { Change, runnerTitle } from "@/components/performance-workflows";
import { ProviderMark, providerOf, RunnerMark } from "@/components/providers";
import { TimeRangePicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  percentChange,
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
// cost per run instead of time; `job` charts one job instead of the whole run.
type Search = {
  repo: number;
  workflow?: string;
  range?: TimeRange;
  metric?: "cost";
  job?: string;
};

const validateSearch = (search: Record<string, unknown>): Search => {
  const repo = Number(search.repo);
  return {
    repo: Number.isSafeInteger(repo) && repo > 0 ? repo : 0,
    workflow: textParam(search.workflow),
    ...ranges.validateSearch(search),
    metric: search.metric === "cost" ? "cost" : undefined,
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

const BASELINE_NAME = "GitHub";

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
  const cost = search.metric === "cost";
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
              {cost
                ? "Each dot is one passing run's cost at list prices. Lines join each runner's daily median."
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
          cost={cost}
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

/** "44 runs", "22 runs · 5 eval". */
function RunsText({ runner }: { runner: WorkflowRunner }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {runner.runs > 0 && <span>{plural(runner.runs, "run")}</span>}
      {runner.runs > 0 && runner.evaluations > 0 && <span aria-hidden>·</span>}
      {runner.evaluations > 0 && (
        <span className="inline-flex items-center gap-1">
          <FlaskConicalIcon aria-hidden className="size-3" />
          {runner.evaluations} eval
        </span>
      )}
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
  const base = report.runners.find((runner) => runner.key === report.baseline) ?? null;
  const rows = report.runners.toSorted(
    (a, b) => (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity),
  );
  // A runner that only ran some jobs is drawn as its jobs' medians end to end.
  const jobsMs = (runner: WorkflowRunner) =>
    Object.values(runner.jobs).reduce((total, job) => total + (job.medianMs ?? 0), 0);
  const maxMs = Math.max(...rows.map((runner) => runner.medianMs ?? jobsMs(runner)), 1);
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
            <th className="w-[32%] min-w-48 px-4 py-2 font-medium">Median run</th>
            <th className="px-4 py-2 font-medium">vs {BASELINE_NAME}</th>
            <th className="px-4 py-2 text-right font-medium">Cost per run</th>
            <th className="px-4 py-2 font-medium">vs {BASELINE_NAME}</th>
            <th className="px-4 py-2 text-right font-medium">Runs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((runner) => (
            <RunnerRow
              key={runner.key}
              runner={runner}
              report={report}
              base={base}
              color={colors.get(runner.key)!}
              charted={charted.has(runner.key)}
              onToggle={() => onToggle(runner.key)}
              open={open === runner.key}
              onOpen={() => setOpen(open === runner.key ? null : runner.key)}
              maxMs={maxMs}
            />
          ))}
          {untried.length > 0 && (
            <>
              <tr className="border-b bg-raised-2/30 text-xs text-muted-foreground">
                <td />
                <td colSpan={6} className="px-2 py-2 font-medium">
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
                  <td className="px-4 py-3">—</td>
                  <td className="px-4 py-3 text-right">—</td>
                  <td className="px-4 py-3">—</td>
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
                  <td colSpan={6} className="px-2 py-2">
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
  base,
  color,
  charted,
  onToggle,
  open,
  onOpen,
  maxMs,
}: {
  runner: WorkflowRunner;
  report: WorkflowReport;
  base: WorkflowRunner | null;
  color: string;
  charted: boolean;
  onToggle: () => void;
  open: boolean;
  onOpen: () => void;
  maxMs: number;
}) {
  const isBase = runner.key === base?.key;
  const few = runner.wholeRuns > 0 && runner.wholeRuns < report.fewRuns;
  const jobs = report.jobs.map((name) => ({ name, stat: runner.jobs[name] ?? null }));
  const sum = jobs.reduce((total, job) => total + (job.stat?.medianMs ?? 0), 0);
  const scale = (runner.medianMs ?? sum) / maxMs;
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
            {isBase && (
              <span className="rounded bg-raised-2 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                baseline
              </span>
            )}
          </button>
        </td>
        <td className="px-4 py-3">
          <div className="grid gap-1.5">
            <span className={cn("font-medium whitespace-nowrap", charted && "text-foreground")}>
              {runner.medianMs === null ? (
                <span className="text-xs font-normal text-muted-foreground">Some jobs only</span>
              ) : (
                `${few ? "~" : ""}${clock(runner.medianMs)}`
              )}
            </span>
            <span className="flex h-2 w-full overflow-hidden rounded-full bg-raised-2">
              <span
                className="flex h-full gap-[2px]"
                style={{ width: `${Math.min(scale, 1) * 100}%` }}
              >
                {jobs.map(({ name, stat }) =>
                  stat?.medianMs ? (
                    <span
                      key={name}
                      title={`${name} ${clock(stat.medianMs)}`}
                      className="h-full"
                      style={{
                        width: `${(stat.medianMs / sum) * 100}%`,
                        background: color,
                        opacity: charted ? 1 : 0.45,
                      }}
                    />
                  ) : null,
                )}
              </span>
            </span>
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          {isBase ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Change pct={percentChange(runner.medianMs, base?.medianMs)} />
          )}
        </td>
        <td
          className={cn(
            "px-4 py-3 text-right font-medium whitespace-nowrap",
            charted && "text-foreground",
          )}
        >
          {runCost(runner.usd)}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          {isBase ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Change pct={percentChange(runner.usd, base?.usd)} />
          )}
        </td>
        <td className="px-4 py-3 text-right text-xs whitespace-nowrap text-muted-foreground">
          <RunsText runner={runner} />
        </td>
      </tr>
      {open &&
        jobs.map(({ name, stat }, index) => {
          const baseJob = base?.jobs[name] ?? null;
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
                  <span className="flex items-center gap-3">
                    <span className="w-10 whitespace-nowrap">{clock(stat.medianMs)}</span>
                    <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-raised-2">
                      <span
                        className="h-full"
                        style={{ width: `${(stat.medianMs / maxMs) * 100}%`, background: color }}
                      />
                    </span>
                  </span>
                )}
              </td>
              <td className="px-4 py-1.5 whitespace-nowrap">
                {isBase || !stat ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Change pct={percentChange(stat.medianMs, baseJob?.medianMs)} />
                )}
              </td>
              <td className="px-4 py-1.5 text-right whitespace-nowrap text-muted-foreground">
                {runCost(stat?.usd)}
              </td>
              <td className="px-4 py-1.5 whitespace-nowrap">
                {isBase || !stat ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Change pct={percentChange(stat.usd, baseJob?.usd)} />
                )}
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

/** "4 vCPU": what tells two runners of one provider apart. A machine's name says enough. */
function runnerSpecText(runner: WorkflowRunner) {
  if (providerOf(runner) === "machine") return null;
  if (runner.size) return `${runner.size.vcpus} vCPU`;
  // A cloud runner named by its provider: its label says which one.
  return runnerTitle(runner) === runner.label ? null : runner.label;
}
