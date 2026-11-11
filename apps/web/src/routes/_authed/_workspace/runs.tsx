import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  type LucideIcon,
  RouteIcon,
  TimerOffIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
  PROVIDERS,
  type Provider,
  ProviderMark,
  providerOf,
  runnerName,
} from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { Collapse } from "@/components/ui/collapse";
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
import {
  getRunJobs,
  getRuns,
  LONG_WAIT_MS,
  type Run,
  type RunJob,
  type RunJobs,
  sampleRunJobs,
  sampleRuns,
  triggerText,
} from "@/lib/runs";
import { cn, elapsed } from "@/lib/utils";

const RANGES = [1, 7, 14] as const;
// While a run is going, how often the list and an open run's jobs are refetched. Paused while the
// tab is hidden or idle (lib/live-refresh.ts).
const LIST_REFRESH_MS = 15_000;
const JOBS_REFRESH_MS = 5_000;
const HOVER_INTENT_MS = 120;

export const Route = createFileRoute("/_authed/_workspace/runs")({
  loader: () => (authDisabled ? Promise.resolve(sampleRuns()) : getRuns()),
  component: RunsPage,
});

type ResultFilter = "all" | "failed" | "running";
type RoutedFilter = "all" | "routed";
/** Each environment's name, by key. */
type Environments = Map<string, string>;

type RunIds = Pick<Run, "repositoryId" | "runId" | "runAttempt" | "startedAt" | "status">;
const runKey = (run: Pick<Run, "repositoryId" | "runId" | "runAttempt">) =>
  `${run.repositoryId}:${run.runId}:${run.runAttempt}`;
const isFailure = (conclusion: string | null) =>
  conclusion === "failure" || conclusion === "timed_out";
const isLongWait = (wait: number | null): wait is number => wait !== null && wait >= LONG_WAIT_MS;

/** The time now, ticking every second while `enabled`. */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function RunsPage() {
  const loaded = Route.useLoaderData();
  // Refetched while a run on screen is going, so new jobs, runs and results show without a reload.
  const [report, setReport] = useState(loaded);
  useEffect(() => setReport(loaded), [loaded]);
  const [days, setDays] = useState(7);
  const [repository, setRepository] = useState("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [routed, setRouted] = useState<RoutedFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const toggle = useCallback((key: string) => setOpen((now) => (now === key ? null : key)), []);

  const repositories = useMemo(
    () => [...new Set(report.runs.map((run) => run.repository))].sort(),
    [report],
  );
  // The report holds the whole window, so the range and the filters are applied here.
  const runs = useMemo(() => {
    const since = Date.now() - days * DAY_MS;
    return report.runs.filter(
      (run) =>
        run.updatedAt >= since &&
        (repository === "all" || run.repository === repository) &&
        (routed === "all" || run.routed) &&
        (result === "all" ||
          (result === "running" ? run.status !== "completed" : isFailure(run.conclusion))),
    );
  }, [report, days, repository, result, routed]);
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
  const environments: Environments = useMemo(
    () => new Map(report.environments.map((env) => [env.key, env.label])),
    [report],
  );

  return (
    <section>
      <PageHeader title="Runs">
        Every workflow run in your connected repos, newest first. Open a run to see where each job
        ran and how long it waited for a runner.
      </PageHeader>
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
        </div>

        {report.runs.length === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            No runs in the last {plural(report.days, "day")}. Runs show up here once the GitHub App
            sees them in a connected repo.
          </p>
        ) : (
          <>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {runs.length === 0 && (
                <li className="px-4 py-6 text-sm text-muted-foreground">
                  No runs match these filters.
                </li>
              )}
              {runs.map((run) => {
                const key = runKey(run);
                return (
                  <RunRow
                    key={key}
                    id={key}
                    run={run}
                    environments={environments}
                    showRepository={repositories.length > 1}
                    open={open === key}
                    onToggle={toggle}
                  />
                );
              })}
            </ul>
            <Legend days={report.days} truncated={report.truncated} />
          </>
        )}
      </div>
    </section>
  );
}

// Memoized: opening one run re-renders that row, not every row.
const RunRow = memo(function RunRow({
  id,
  run,
  environments,
  showRepository,
  open,
  onToggle,
}: {
  id: string;
  run: Run;
  environments: Environments;
  showRepository: boolean;
  open: boolean;
  onToggle: (key: string) => void;
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
  // the detail opens at its full height instead of growing out of a loading line. A hover only
  // counts once it rests, so sweeping the pointer down the list doesn't fetch every run.
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prefetch = () => void fetchRunJobs(run).catch(() => undefined);

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(id)}
        onPointerEnter={() => (hover.current = setTimeout(prefetch, HOVER_INTENT_MS))}
        onPointerLeave={() => clearTimeout(hover.current)}
        onFocus={prefetch}
        className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 px-4 py-3 text-left outline-none hover:bg-secondary/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[auto_1fr_auto_auto] sm:gap-x-5"
      >
        <StatusIcon run={run} />
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
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-200 ease-out",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      <Collapse open={open}>
        <RunDetail run={run} environments={environments} />
      </Collapse>
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
    const { name } = PROVIDERS[provider];
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

// The last jobs fetched for the most recent runs, so a run opens with its jobs already there when
// it was hovered first or opened before.
type JobsEntry = { status: Run["status"]; at: number; request: Promise<RunJobs>; jobs?: RunJobs };
const jobsCache = new Map<string, JobsEntry>();
const JOBS_CACHE_SIZE = 50;

/**
 * A run's jobs, from the cache unless the run's status has changed since or, for a run still
 * going, the cached answer is older than a refresh. `fresh` always asks again.
 */
function fetchRunJobs(run: RunIds, fresh = false) {
  const key = runKey(run);
  const cached = jobsCache.get(key);
  const current =
    cached?.status === run.status &&
    (run.status === "completed" || Date.now() - cached.at < JOBS_REFRESH_MS);
  if (cached && current && !fresh) return cached.request;
  const request = authDisabled ? Promise.resolve(sampleRunJobs(run)) : getRunJobs(run);
  const entry: JobsEntry = { status: run.status, at: Date.now(), request };
  request.then(
    (jobs) => (entry.jobs = jobs),
    () => jobsCache.get(key) === entry && jobsCache.delete(key),
  );
  jobsCache.delete(key); // Re-added last, so the oldest run is first to go.
  jobsCache.set(key, entry);
  if (jobsCache.size > JOBS_CACHE_SIZE) jobsCache.delete(jobsCache.keys().next().value!);
  return request;
}

function cachedJobs(run: RunIds) {
  const cached = jobsCache.get(runKey(run));
  return (cached?.status === run.status && cached.jobs) || null;
}

type Status = { Icon: LucideIcon; label: string; className: string };
const CANCELLED: Status = {
  Icon: CircleSlashIcon,
  label: "Cancelled",
  className: "text-muted-foreground",
};
const LIVE = {
  in_progress: { Icon: LoaderCircleIcon, label: "In progress", className: "animate-spin text-run" },
  queued: { Icon: CircleDashedIcon, label: "Queued", className: "text-muted-foreground" },
} satisfies Record<string, Status>;
const STATUS: Record<string, Status> = {
  ...LIVE,
  success: { Icon: CircleCheckIcon, label: "Succeeded", className: "text-go" },
  failure: { Icon: CircleXIcon, label: "Failed", className: "text-destructive" },
  timed_out: { Icon: TimerOffIcon, label: "Timed out", className: "text-destructive" },
  cancelled: CANCELLED,
};

function StatusIcon({ run }: { run: Run }) {
  const { Icon, label, className } = STATUS[
    run.status === "completed" ? (run.conclusion ?? "") : run.status
  ] ?? { ...CANCELLED, label: run.conclusion ?? "Finished" };
  return <Icon role="img" aria-label={label} className={cn("size-[18px] shrink-0", className)} />;
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

// A job still queued has waited until now, and one still running has run until now.
function waitOf(job: RunJob, now: number) {
  if (job.queuedAt === null) return null;
  const end = job.startedAt ?? (job.status === "queued" ? now : null);
  return end === null ? null : end - job.queuedAt;
}
const ranOf = (job: RunJob, now: number) =>
  job.startedAt === null ? null : (job.completedAt ?? now) - job.startedAt;

function RunDetail({ run, environments }: { run: Run; environments: Environments }) {
  const [detail, setDetail] = useState<RunJobs | null>(() => cachedJobs(run));
  const [failed, setFailed] = useState(false);
  // Keyed on the run's ids and status, not the object: the same run in a new report needn't load
  // again, but it does once it finishes.
  const { repositoryId, runId, runAttempt, startedAt, status } = run;
  const running = status !== "completed";
  const ids = useMemo(
    () => ({ repositoryId, runId, runAttempt, startedAt, status }),
    [repositoryId, runId, runAttempt, startedAt, status],
  );
  useEffect(() => {
    let live = true;
    fetchRunJobs(ids)
      .then((value) => live && setDetail(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [ids]);
  useLiveRefresh(
    () =>
      fetchRunJobs(ids, true)
        .then(setDetail)
        .catch(() => undefined), // Keep showing the last answer; the next tick retries.
    { intervalMs: JOBS_REFRESH_MS, enabled: running && !authDisabled },
  );
  // Times of jobs still going run to now. Once the run has finished they stop where it did, so a
  // job GitHub never said finished (a lost webhook) doesn't keep counting.
  const ticking = useNow(
    running && Boolean(detail?.jobs.some((job) => job.status !== "completed")),
  );
  const now = running ? ticking : run.updatedAt;

  // A runner's name from the page's environments first, then the detail's own.
  const own = new Map(detail?.environments.map((env) => [env.key, env.label]));
  const label = (key: string) => environments.get(key) ?? own.get(key) ?? key;
  let longest: { job: RunJob; wait: number } | null = null;
  for (const job of detail?.jobs ?? []) {
    const wait = waitOf(job, now);
    if (isLongWait(wait) && wait > (longest?.wait ?? 0)) longest = { job, wait };
  }
  let note: string | null = null;
  if (longest) {
    const { job, wait } = longest;
    const verb = job.status === "queued" ? "has waited" : "waited";
    const runner = job.environment ? label(job.environment) : "a runner";
    note = `${job.name} ${verb} ${elapsed(wait)} for ${runner}.`;
  } else if (running) note = "Jobs that need others show up once GitHub queues them.";

  return (
    <div className="border-t bg-secondary/40 px-4 py-3 sm:pl-12">
      {failed ? (
        <p className="text-sm text-muted-foreground">Couldn't load this run's jobs.</p>
      ) : !detail ? (
        <JobsPlaceholder rows={Math.max(run.environments.length, 1)} />
      ) : (
        <div className="grid gap-3">
          {detail.jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {running ? "No jobs have been queued in this run yet." : "No jobs seen for this run."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="py-1.5 pr-4 text-left font-normal">
                      Job
                    </th>
                    <th scope="col" className="py-1.5 pr-4 text-left font-normal">
                      Runs on
                    </th>
                    <th scope="col" className="py-1.5 pr-4 text-right font-normal">
                      Wait
                    </th>
                    <th scope="col" className="py-1.5 pr-4 text-right font-normal">
                      Run
                    </th>
                    <th scope="col" className="py-1.5 text-right font-normal">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.jobs.map((job) => {
                    const wait = waitOf(job, now);
                    const queued = job.status === "queued";
                    return (
                      <tr key={job.id}>
                        <th
                          scope="row"
                          className="py-1.5 pr-4 text-left font-normal whitespace-nowrap"
                        >
                          {job.name}
                        </th>
                        <td className="py-1.5 pr-4 whitespace-nowrap">
                          {job.environment ? (
                            <span
                              className={cn(
                                "inline-flex items-center gap-2",
                                queued && "text-muted-foreground",
                              )}
                            >
                              <ProviderMark
                                provider={providerOf({ key: job.environment })}
                                className={cn(queued && "opacity-50")}
                              />
                              {queued
                                ? `Waiting for ${label(job.environment)}`
                                : label(job.environment)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">No runner took it</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "py-1.5 pr-4 text-right",
                            isLongWait(wait) && "font-semibold text-run",
                          )}
                        >
                          {elapsed(wait)}
                        </td>
                        <td className="py-1.5 pr-4 text-right">{elapsed(ranOf(job, now))}</td>
                        <td className="py-1.5 text-right">
                          <JobResult job={job} running={running} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{note}</span>
            <a
              href={run.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
            >
              Open on GitHub
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function JobResult({ job, running }: { job: RunJob; running: boolean }) {
  if (job.status !== "completed" && !running)
    return <span className="text-muted-foreground">Unknown</span>;
  if (job.status !== "completed") {
    const { Icon, label, className } = LIVE[job.status];
    return (
      <span className="inline-flex items-center justify-end gap-1.5 text-muted-foreground">
        <Icon aria-hidden className={cn("size-3.5", className)} />
        {label}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "capitalize",
        job.conclusion === "success"
          ? "text-go"
          : isFailure(job.conclusion)
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      {(job.conclusion ?? "done").replace("_", " ")}
    </span>
  );
}

/**
 * Holds the space of the jobs table while a run's jobs load (rarely seen, since hovering a run
 * starts the load), so the detail opens near its final height instead of from a single line.
 */
function JobsPlaceholder({ rows }: { rows: number }) {
  return (
    <div aria-busy aria-label="Loading jobs" className="grid gap-3">
      <div className="grid">
        <div className="flex h-7 items-center">
          <span className="h-2.5 w-12 rounded-sm bg-secondary" />
        </div>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex h-8 items-center gap-4">
            <span className="h-3 w-40 max-w-[40%] rounded-sm bg-secondary" />
            <span className="h-3 w-32 max-w-[30%] rounded-sm bg-secondary" />
          </div>
        ))}
      </div>
      <div className="h-4" />
    </div>
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
