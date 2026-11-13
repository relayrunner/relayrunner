import { createFileRoute } from "@tanstack/react-router";
import { ChevronRightIcon, RouteIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DurationChart, runPoints } from "@/components/duration-chart";
import { SectionBoundary } from "@/components/error-boundary";
import { JobList } from "@/components/job-list";
import { PageHeader } from "@/components/page-header";
import { PageTabs, type Tab, viewOf } from "@/components/page-tabs";
import {
  providerStyle,
  type Provider,
  ProviderMark,
  providerOf,
  runnerName,
} from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { type Environments, fetchRunJobs, RunLink, RunSheet } from "@/components/run-sheet";
import { StatusIcon } from "@/components/status-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeAgo } from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import { DAY_MS, plural } from "@/lib/job-times";
import { useLiveRefresh } from "@/lib/live-refresh";
import { useNow } from "@/lib/use-now";
import {
  getJobs,
  getRuns,
  isFailure,
  type JobsReport,
  parseRunParam,
  type Run,
  type RunsReport,
  runParam,
  sampleJobs,
  sampleRuns,
  triggerText,
} from "@/lib/runs";
import { cn, elapsed } from "@/lib/utils";

const RANGES = [1, 7, 14] as const;
// While a run is going, how often the list is refetched. Paused while the tab is hidden or idle
// (lib/live-refresh.ts).
const LIST_REFRESH_MS = 15_000;
const HOVER_INTENT_MS = 120;

const TABS = [
  { value: "workflows", label: "Workflows" },
  { value: "jobs", label: "Jobs" },
] as const satisfies Tab<string>[];
type View = (typeof TABS)[number]["value"];
// The job list's first range. Its range picker loads others.
const JOB_DAYS = 7;

type Loaded = { view: "workflows"; runs: RunsReport } | { view: "jobs"; jobs: JobsReport };

// `run` and `job` name the run attempt and job open in the detail panel, in either view.
type Search = { view?: View; run?: string; job?: number };

export const Route = createFileRoute("/_authed/_workspace/history")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const run = parseRunParam(search.run) ? (search.run as string) : undefined;
    const job = Number(search.job);
    return {
      view: viewOf(TABS, search.view),
      run,
      job: run && Number.isSafeInteger(job) && job > 0 ? job : undefined,
    };
  },
  loaderDeps: ({ search }) => ({ view: search.view ?? "workflows" }),
  loader: async ({ deps: { view } }): Promise<Loaded> => {
    if (view === "jobs")
      return { view, jobs: authDisabled ? sampleJobs(JOB_DAYS) : await getJobs(JOB_DAYS) };
    return { view, runs: authDisabled ? sampleRuns() : await getRuns() };
  },
  // A tab shows as it was when it's come back to: the Workflows tab refreshes itself while runs
  // are going, and opening or closing the panel only changes the search.
  shouldReload: ({ cause }) => cause === "enter",
  component: HistoryPage,
});

/** A Map of each environment's name, by key. */
const namesOf = (report: { environments: { key: string; label: string }[] }): Environments =>
  new Map(report.environments.map((env) => [env.key, env.label]));

/** The panel the URL opens, if any, with the run from the list when the list has it. */
function Panel({ runs, environments }: { runs?: Run[]; environments: Environments }) {
  const { run, job } = Route.useSearch();
  const ids = parseRunParam(run);
  if (!ids) return null;
  return (
    <SectionBoundary>
      <RunSheet
        key={run}
        ids={ids}
        jobId={job}
        run={runs?.find((each) => runParam(each) === run)}
        environments={environments}
      />
    </SectionBoundary>
  );
}

function HistoryPage() {
  const loaded = Route.useLoaderData();
  return (
    <section>
      <PageHeader title="History">
        Every workflow run and job in your connected repos, newest first. Open a run to see where
        each of its jobs ran and how long it waited for a runner.
      </PageHeader>
      <PageTabs tabs={TABS} value={loaded.view} />
      {loaded.view === "jobs" ? (
        <Jobs report={loaded.jobs} />
      ) : (
        <WorkflowRuns loaded={loaded.runs} />
      )}
    </section>
  );
}

function Jobs({ report }: { report: JobsReport }) {
  const environments = useMemo(() => namesOf(report), [report]);
  return (
    <>
      <JobList report={report} />
      <Panel environments={environments} />
    </>
  );
}

type ResultFilter = "all" | "failed" | "running";
type RoutedFilter = "all" | "routed";
type RunSort = "newest" | "longest" | "slowest";
// Runs still going, and ones without a usual time to compare with, go last.
const SORTS: Record<RunSort, ((run: Run) => number) | null> = {
  newest: null, // The report's own order.
  longest: (run) => run.wallMs ?? -1,
  slowest: (run) => (run.wallMs !== null && run.usualMs ? run.wallMs / run.usualMs : -1),
};
function WorkflowRuns({ loaded }: { loaded: RunsReport }) {
  const open = Route.useSearch({ select: (search) => search.run });
  // Refetched while a run on screen is going, so new jobs, runs and results show without a reload.
  const [report, setReport] = useState(loaded);
  useEffect(() => setReport(loaded), [loaded]);
  const [days, setDays] = useState(7);
  const [repository, setRepository] = useState("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [routed, setRouted] = useState<RoutedFilter>("all");
  const [sort, setSort] = useState<RunSort>("newest");

  const repositories = useMemo(
    () => [...new Set(report.runs.map((run) => run.repository))].sort(),
    [report],
  );
  // The report holds the whole window, so the range and the filters are applied here.
  const runs = useMemo(() => {
    const since = Date.now() - days * DAY_MS;
    const shown = report.runs.filter(
      (run) =>
        run.updatedAt >= since &&
        (repository === "all" || run.repository === repository) &&
        (routed === "all" || run.routed) &&
        (result === "all" ||
          (result === "running" ? run.status !== "completed" : isFailure(run.conclusion))),
    );
    const by = SORTS[sort];
    return by ? shown.sort((a, b) => by(b) - by(a)) : shown;
  }, [report, days, repository, result, routed, sort]);
  const chartPoints = useMemo(() => runPoints(runs), [runs]);
  useLiveRefresh(
    () =>
      getRuns()
        .then(setReport)
        .catch(() => undefined), // Keep showing the last answer; the next tick retries.
    {
      intervalMs: LIST_REFRESH_MS,
      enabled: !authDisabled && runs.some((run) => run.status !== "completed"),
    },
  );
  const environments = useMemo(() => namesOf(report), [report]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <RangePicker ranges={RANGES} days={days} onChange={setDays} />
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
            <SelectItem value="running">In progress</SelectItem>
          </SelectContent>
        </Select>
        <Select value={routed} onValueChange={(value) => setRouted(value as RoutedFilter)}>
          <SelectTrigger size="sm" aria-label="Routing">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All runs</SelectItem>
            <SelectItem value="routed">Routed by RelayRunner</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as RunSort)}>
          <SelectTrigger size="sm" aria-label="Sort runs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="longest">Longest first</SelectItem>
            <SelectItem value="slowest">Slowest vs. usual</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {report.runs.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
          No runs in the last {plural(report.days, "day")}. Runs show up here once the GitHub App
          sees them in a connected repo.
        </p>
      ) : (
        <>
          <SectionBoundary>
            <DurationChart points={chartPoints} days={days} noun="run" />
          </SectionBoundary>
          <SectionBoundary>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {runs.length === 0 && (
                <li className="px-4 py-6 text-sm text-muted-foreground">
                  No runs match these filters.
                </li>
              )}
              {runs.map((run) => {
                const key = runParam(run);
                return (
                  <RunRow
                    key={key}
                    run={run}
                    environments={environments}
                    showRepository={repositories.length > 1}
                    open={open === key}
                  />
                );
              })}
            </ul>
          </SectionBoundary>
          <Legend days={report.days} truncated={report.truncated} />
        </>
      )}
      <Panel runs={report.runs} environments={environments} />
    </div>
  );
}

// Memoized: opening one run re-renders that row, not every row.
const RunRow = memo(function RunRow({
  run,
  environments,
  showRepository,
  open,
}: {
  run: Run;
  environments: Environments;
  showRepository: boolean;
  open: boolean;
}) {
  const meta = [
    run.title ? run.workflow : null,
    showRepository ? run.repository : null,
    run.actor,
    triggerText(run),
    run.branch,
    run.runAttempt > 1 ? `attempt ${run.runAttempt}` : null,
    run.startedAt ? timeAgo(run.startedAt) : null,
  ].filter(Boolean);
  // Opening a run usually follows a hover or focus by a moment, so its jobs start loading then and
  // the panel opens with them in place. A hover only counts once it rests, so sweeping the pointer
  // down the list doesn't fetch every run.
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prefetch = () => void fetchRunJobs(run, run.status).catch(() => undefined);

  return (
    <li>
      <RunLink
        run={run}
        aria-current={open ? "true" : undefined}
        onPointerEnter={() => (hover.current = setTimeout(prefetch, HOVER_INTENT_MS))}
        onPointerLeave={() => clearTimeout(hover.current)}
        onFocus={prefetch}
        className={cn(
          "grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 px-4 py-3 text-left outline-none hover:bg-secondary/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[auto_1fr_auto_auto] sm:gap-x-5",
          open && "bg-secondary/40",
        )}
      >
        <StatusIcon status={run.status} conclusion={run.conclusion} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">
              {run.title ?? run.workflow ?? "Unnamed workflow"}
            </span>
            {run.routed && (
              <span title="Routed by RelayRunner" className="shrink-0 text-muted-foreground">
                <RouteIcon role="img" aria-label="Routed by RelayRunner" className="size-3.5" />
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{meta.join(" · ")}</span>
        </span>
        <RanOn keys={run.environments} environments={environments} />
        <span className="flex items-center gap-2">
          <WallTime run={run} />
          <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
        </span>
      </RunLink>
    </li>
  );
});

/** Where a run's jobs ran, one mark per provider, each naming its runners on hover. */
function RanOn({ keys, environments }: { keys: string[]; environments: Environments }) {
  const byProvider = new Map<Provider, string[]>();
  for (const key of keys) {
    const provider = providerOf({ key });
    const names = byProvider.get(provider) ?? [];
    names.push(runnerName(provider, environments.get(key) ?? key));
    byProvider.set(provider, names);
  }
  const marks = [...byProvider].map(([provider, names]) => {
    const { name } = providerStyle(provider);
    return { provider, title: names.join(", ") === name ? name : `${name}: ${names.join(", ")}` };
  });
  return (
    <span
      className="hidden items-center gap-1 sm:flex"
      aria-label={`Ran on ${marks.map((mark) => mark.title).join("; ")}`}
    >
      {marks.map(({ provider, title }) => (
        <span key={provider} title={title}>
          <ProviderMark provider={provider} />
        </span>
      ))}
    </span>
  );
}

/**
 * The run's wall time, over a bar against the workflow's usual time: the tick is the usual time
 * and the bar fills to twice it, so a run slower than usual runs past the tick in amber.
 */
function WallTime({ run }: { run: Run }) {
  const running = run.status !== "completed";
  const now = useNow(running);
  const ms = running ? (run.startedAt ? now - run.startedAt : null) : run.wallMs;
  return (
    <span className="grid w-20 justify-items-end gap-1 tabular-nums">
      <span className={cn("text-sm font-semibold", running && "font-normal text-muted-foreground")}>
        {elapsed(ms)}
      </span>
      {run.usualMs !== null && ms !== null && (
        <span
          className="relative h-1 w-full overflow-hidden rounded-full bg-secondary"
          title={`Usual time ${elapsed(run.usualMs)}`}
        >
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              ms > run.usualMs ? "bg-run" : "bg-muted-foreground/60",
            )}
            style={{ width: `${Math.min(ms / (2 * run.usualMs), 1) * 100}%` }}
          />
          <span className="absolute inset-y-0 left-1/2 w-px bg-foreground/50" />
        </span>
      )}
    </span>
  );
}

function Legend({ days, truncated }: { days: number; truncated: boolean }) {
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p className="inline-flex items-center gap-1.5">
        <RouteIcon aria-hidden className="size-3.5" />
        Routed by RelayRunner
      </p>
      <p className="max-w-[62ch]">
        The bar under each time compares the run with its workflow's usual time, the p90 of its
        successful runs over the last {plural(days, "day")}. The tick is the usual time; a run past
        it shows in amber.
        {truncated && " Only the newest runs are shown."}
      </p>
    </div>
  );
}
