import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  RouteIcon,
  TimerOffIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { type Environment, environmentColor } from "@/lib/job-times";
import {
  elapsed,
  getRunJobs,
  getRuns,
  LONG_WAIT_MS,
  type Run,
  type RunJobs,
  type RunsReport,
  sampleRunJobs,
  sampleRuns,
  triggerText,
} from "@/lib/runs";
import { cn } from "@/lib/utils";

const RANGES = [1, 7, 14] as const;

function load(days: number) {
  return authDisabled ? Promise.resolve(sampleRuns(days)) : getRuns(days);
}

function loadJobs(run: Run) {
  return authDisabled ? Promise.resolve(sampleRunJobs(run)) : getRunJobs(run);
}

export const Route = createFileRoute("/_authed/_workspace/runs")({
  loader: () => load(7),
  component: RunsPage,
});

type ResultFilter = "all" | "failed" | "running";
type RoutedFilter = "all" | "routed";

const runKey = (run: Run) => `${run.repositoryId}:${run.runId}:${run.runAttempt}`;

function RunsPage() {
  const first = Route.useLoaderData();
  const [report, setReport] = useState<RunsReport>(first);
  const [repository, setRepository] = useState("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [routed, setRouted] = useState<RoutedFilter>("all");
  const [open, setOpen] = useState<string | null>(null);

  function chooseRange(days: number) {
    load(days)
      .then(setReport)
      .catch(() => undefined);
  }

  const repositories = useMemo(
    () => [...new Set(report.runs.map((run) => run.repository))].sort(),
    [report],
  );
  // Filtered here, from the runs already loaded, so changing a filter reads nothing more.
  const runs = useMemo(
    () =>
      report.runs.filter(
        (run) =>
          (repository === "all" || run.repository === repository) &&
          (routed === "all" || run.routed) &&
          (result === "all" ||
            (result === "running" ? run.status !== "completed" : isFailure(run.conclusion))),
      ),
    [report, repository, result, routed],
  );
  const colors = useMemo(
    () => new Map(report.environments.map((env, index) => [env.key, environmentColor(index)])),
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
            No runs in the last {report.days === 1 ? "day" : `${report.days} days`}. Runs show up
            here once the GitHub App sees them in a connected repo.
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
                    run={run}
                    colors={colors}
                    environments={report.environments}
                    showRepository={repositories.length > 1}
                    open={open === key}
                    onToggle={() => setOpen(open === key ? null : key)}
                  />
                );
              })}
            </ul>
            <Legend report={report} colors={colors} truncated={report.truncated} />
          </>
        )}
      </div>
    </section>
  );
}

function isFailure(conclusion: string | null) {
  return conclusion === "failure" || conclusion === "timed_out";
}

function RunRow({
  run,
  colors,
  environments,
  showRepository,
  open,
  onToggle,
}: {
  run: Run;
  colors: Map<string, string | undefined>;
  environments: Environment[];
  showRepository: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const names = new Map(environments.map((env) => [env.key, env.label]));
  const meta = [
    run.title ? run.workflow : null,
    showRepository ? run.repository : null,
    run.actor,
    triggerText(run),
    run.branch,
    run.runAttempt > 1 ? `attempt ${run.runAttempt}` : null,
    run.startedAt ? timeAgo(new Date(run.startedAt).toISOString()) : null,
  ].filter(Boolean);

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
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
          aria-label={`Ran on ${run.environments.map((key) => names.get(key) ?? key).join(", ")}`}
        >
          {run.environments.map((key) => (
            <span
              key={key}
              title={names.get(key) ?? key}
              className="inline-block h-2 w-5 rounded-[3px]"
              style={{ background: colors.get(key) }}
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
      {open && <RunDetail run={run} colors={colors} />}
    </li>
  );
}

function StatusIcon({ run }: { run: Run }) {
  const icon = "size-[18px] shrink-0";
  if (run.status === "in_progress")
    return (
      <LoaderCircleIcon
        role="img"
        aria-label="In progress"
        className={cn(icon, "animate-spin text-run")}
      />
    );
  if (run.status === "queued")
    return (
      <CircleDashedIcon
        role="img"
        aria-label="Queued"
        className={cn(icon, "text-muted-foreground")}
      />
    );
  switch (run.conclusion) {
    case "success":
      return <CircleCheckIcon role="img" aria-label="Succeeded" className={cn(icon, "text-go")} />;
    case "failure":
      return (
        <CircleXIcon role="img" aria-label="Failed" className={cn(icon, "text-destructive")} />
      );
    case "timed_out":
      return (
        <TimerOffIcon role="img" aria-label="Timed out" className={cn(icon, "text-destructive")} />
      );
    default:
      return (
        <CircleSlashIcon
          role="img"
          aria-label={run.conclusion === "cancelled" ? "Cancelled" : (run.conclusion ?? "Finished")}
          className={cn(icon, "text-muted-foreground")}
        />
      );
  }
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
  const slow = run.usualMs !== null && ms !== null && ms > run.usualMs;
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
              slow ? "bg-run" : "bg-muted-foreground/60",
            )}
            style={{ width: `${Math.min(ms / (2 * run.usualMs), 1) * 100}%` }}
          />
          <span className="absolute inset-y-0 left-1/2 w-px bg-foreground/50" />
        </span>
      )}
    </span>
  );
}

function RunDetail({ run, colors }: { run: Run; colors: Map<string, string | undefined> }) {
  const [detail, setDetail] = useState<RunJobs | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadJobs(run)
      .then((value) => live && setDetail(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [run]);

  const names = new Map(detail?.environments.map((env) => [env.key, env.label]));
  const waitOf = (job: RunJobs["jobs"][number]) =>
    job.queuedAt !== null && job.startedAt !== null ? job.startedAt - job.queuedAt : null;
  const longest = detail?.jobs.reduce<{ name: string; wait: number; env: string | null } | null>(
    (worst, job) => {
      const wait = waitOf(job);
      return wait !== null && wait >= LONG_WAIT_MS && (!worst || wait > worst.wait)
        ? { name: job.name, wait, env: job.environment }
        : worst;
    },
    null,
  );

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
                                  background: colors.get(job.environment) ?? "currentColor",
                                }}
                              />
                              {names.get(job.environment) ?? job.environment}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Waiting for a runner</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "py-1.5 pr-4 text-right",
                            wait !== null && wait >= LONG_WAIT_MS && "font-semibold text-run",
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
                `${longest.name} waited ${elapsed(longest.wait)} for ${
                  longest.env ? (names.get(longest.env) ?? "its runner") : "a runner"
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

function JobResult({ job }: { job: RunJobs["jobs"][number] }) {
  if (job.status !== "completed")
    return <span className="text-run">{job.status.replace("_", " ")}</span>;
  const text = (job.conclusion ?? "done").replace("_", " ");
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
      {text}
    </span>
  );
}

function Legend({
  report,
  colors,
  truncated,
}: {
  report: RunsReport;
  colors: Map<string, string | undefined>;
  truncated: boolean;
}) {
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        {report.environments.map((env) => (
          <span key={env.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-4 rounded-[3px]"
              style={{ background: colors.get(env.key) }}
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
        successful runs over the last {report.usualDays} days. The tick is the usual time; a run
        past it shows in amber.
        {truncated && " Only the newest runs are shown; pick a shorter range to see the rest."}
      </p>
    </div>
  );
}
