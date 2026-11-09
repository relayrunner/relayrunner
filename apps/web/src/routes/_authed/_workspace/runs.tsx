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
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { RangePicker } from "@/components/range-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeAgo } from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import { DAY_MS, environmentColor, plural } from "@/lib/job-times";
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

export const Route = createFileRoute("/_authed/_workspace/runs")({
  loader: () => (authDisabled ? Promise.resolve(sampleRuns()) : getRuns()),
  component: RunsPage,
});

type ResultFilter = "all" | "failed" | "running";
type RoutedFilter = "all" | "routed";
/** Each environment's name and colour, by key. */
type Environments = Map<string, { label: string; color: string | undefined }>;

const runKey = (run: Run) => `${run.repositoryId}:${run.runId}:${run.runAttempt}`;
const isFailure = (conclusion: string | null) =>
  conclusion === "failure" || conclusion === "timed_out";
const isLongWait = (wait: number | null): wait is number => wait !== null && wait >= LONG_WAIT_MS;

function RunsPage() {
  const report = Route.useLoaderData();
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
  const environments: Environments = useMemo(
    () =>
      new Map(
        report.environments.map((env, index) => [
          env.key,
          { label: env.label, color: environmentColor(index) },
        ]),
      ),
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
            <Legend days={report.days} truncated={report.truncated} environments={environments} />
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
  const label = (key: string) => environments.get(key)?.label ?? key;

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(id)}
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
        <span
          className="hidden items-center gap-1 sm:flex"
          aria-label={`Ran on ${run.environments.map(label).join(", ")}`}
        >
          {run.environments.map((key) => (
            <span
              key={key}
              title={label(key)}
              className="inline-block h-2 w-5 rounded-[3px]"
              style={{ background: environments.get(key)?.color }}
            />
          ))}
        </span>
        <span className="flex items-center gap-2">
          <WallTime run={run} />
          <ChevronRightIcon
            aria-hidden
            className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        </span>
      </button>
      {open && <RunDetail run={run} environments={environments} />}
    </li>
  );
});

type Status = { Icon: LucideIcon; label: string; className: string };
const CANCELLED: Status = {
  Icon: CircleSlashIcon,
  label: "Cancelled",
  className: "text-muted-foreground",
};
const STATUS: Record<string, Status> = {
  in_progress: { Icon: LoaderCircleIcon, label: "In progress", className: "animate-spin text-run" },
  queued: { Icon: CircleDashedIcon, label: "Queued", className: "text-muted-foreground" },
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
  const [now, setNow] = useState(Date.now());
  const running = run.status !== "completed";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
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

const waitOf = (job: RunJob) =>
  job.queuedAt !== null && job.startedAt !== null ? job.startedAt - job.queuedAt : null;

function RunDetail({ run, environments }: { run: Run; environments: Environments }) {
  const [detail, setDetail] = useState<RunJobs | null>(null);
  const [failed, setFailed] = useState(false);
  // Keyed on the run's ids, not the object: the same run in a new report needn't load again.
  const { repositoryId, runId, runAttempt, startedAt } = run;
  useEffect(() => {
    let live = true;
    (authDisabled
      ? Promise.resolve(sampleRunJobs({ runId, startedAt }))
      : getRunJobs({ repositoryId, runId, runAttempt })
    )
      .then((value) => live && setDetail(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [repositoryId, runId, runAttempt, startedAt]);

  // A runner's name from the page's environments first, then the detail's own.
  const own = new Map(detail?.environments.map((env) => [env.key, env.label]));
  const label = (key: string) => environments.get(key)?.label ?? own.get(key) ?? key;
  let longest: { job: RunJob; wait: number } | null = null;
  for (const job of detail?.jobs ?? []) {
    const wait = waitOf(job);
    if (isLongWait(wait) && wait > (longest?.wait ?? 0)) longest = { job, wait };
  }

  return (
    <div className="border-t bg-secondary/40 px-4 py-3 sm:pl-12">
      {failed ? (
        <p className="text-sm text-muted-foreground">Couldn't load this run's jobs.</p>
      ) : !detail ? (
        <p className="text-sm text-muted-foreground">Loading jobs…</p>
      ) : (
        <div className="grid gap-3">
          {detail.jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No jobs have finished in this run yet.</p>
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
                    const wait = waitOf(job);
                    const ran =
                      job.startedAt !== null && job.completedAt !== null
                        ? job.completedAt - job.startedAt
                        : null;
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
                            <span className="inline-flex items-center gap-2">
                              <span
                                aria-hidden
                                className="inline-block h-2 w-4 rounded-[3px]"
                                style={{
                                  background:
                                    environments.get(job.environment)?.color ?? "currentColor",
                                }}
                              />
                              {label(job.environment)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Waiting for a runner</span>
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
                        <td className="py-1.5 pr-4 text-right">{elapsed(ran)}</td>
                        <td className="py-1.5 text-right capitalize">
                          <JobResult job={job} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {longest &&
                `${longest.job.name} waited ${elapsed(longest.wait)} for ${
                  longest.job.environment ? label(longest.job.environment) : "a runner"
                }.`}
            </span>
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

function JobResult({ job }: { job: RunJob }) {
  if (job.status !== "completed")
    return <span className="text-run">{job.status.replace("_", " ")}</span>;
  return (
    <span
      className={cn(
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

function Legend({
  days,
  truncated,
  environments,
}: {
  days: number;
  truncated: boolean;
  environments: Environments;
}) {
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        {[...environments].map(([key, env]) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-4 rounded-[3px]"
              style={{ background: env.color }}
            />
            {env.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <RouteIcon aria-hidden className="size-3.5" />
          Routed by RelayRunner
        </span>
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
