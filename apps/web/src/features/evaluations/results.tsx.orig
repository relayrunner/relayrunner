// An evaluation's runs and its comparison with how the workflow runs today. The public evaluate
// page (routes/evaluate.$provider.tsx) shows it with sample data too.
import { SectionBoundary } from "@/components/error-boundary";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CircleDashedIcon,
  SquareIcon,
  ClockIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { providerStyle } from "@/components/providers";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import {
  ACTIVE_STATES,
  RECENT_DAYS,
  type Attempt,
  type AttemptJob,
  cancelEvaluation,
  type EvaluationReport,
  jobUrl,
  runUrl,
  type Split,
} from "@/lib/evaluations";
import { clock, plural } from "@/lib/job-times";
import { providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";
import { workflowFile, about } from "@/features/evaluations/shared";

export function RunMeta({ report }: { report: EvaluationReport }) {
  const url = runUrl(report);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <WorkflowIcon aria-hidden className="size-4" />
        <span>
          {report.repository} · {report.workflow ?? workflowFile(report.workflowPath)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <GitBranchIcon aria-hidden className="size-4" />
        {report.ref}
      </span>
      <span className="font-mono text-[13px]">{report.label}</span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 hover:text-foreground"
        >
          Run on GitHub
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </a>
      )}
    </div>
  );
}

// ---- Results -------------------------------------------------------------------------------------

const total = (split: Split) => split.waitMs + split.runMs;

function change(from: number | null, to: number | null) {
  if (!from || to === null) return null;
  const pct = Math.round(((to - from) / from) * 100);
  return {
    pct,
    text: pct === 0 ? "Same" : pct < 0 ? `${-pct}% faster` : `${pct}% slower`,
  };
}

/** Dollars to the cent, or a tenth of a cent under a dime, so small runs don't all read $0.01. */
function usd(value: number | null) {
  if (value === null) return "—";
  return `$${value.toFixed(value > 0 && value < 0.1 ? 3 : 2)}`;
}

/** "16% more than", "Same as" or "16% less than" today, or null when either cost is unknown. */
function costChange(from: number | null, to: number | null) {
  if (from === null || to === null) return null;
  if (from === 0) return to === 0 ? "Same as" : null;
  const pct = Math.round(((to - from) / from) * 100);
  return pct === 0 ? "Same as" : pct < 0 ? `${-pct}% less than` : `${pct}% more than`;
}

function costDetail(name: string, runUsd: number | null, todayUsd: number | null) {
  if (runUsd === null) return `No list price for ${name}`;
  if (todayUsd === null) return "Today's runners have no list price";
  const vs = costChange(todayUsd, runUsd);
  return vs ? `${vs} ${usd(todayUsd)} today` : `Today ${usd(todayUsd)}`;
}

/**
 * One evaluation, from its first run to the comparison: the numbers fill in as runs finish, the
 * run going now shows its jobs, and the rest wait in line. Stopping keeps the runs that finished.
 */
export function Results({
  report,
  editable,
  onChange,
  preview,
}: {
  report: EvaluationReport;
  editable: boolean;
  onChange: () => void;
  /** A sample shown before sign-in (routes/evaluate.$provider.tsx): no actions or fine print. */
  preview?: boolean;
}) {
  const { name } = providerInfo(report.provider);
  const active = ACTIVE_STATES.includes(report.state);
  const stopped = report.state === "failed" || report.state === "cancelled";
  // Runs that passed: a failed run stopped partway, so it isn't compared.
  const finished = report.attempts.filter(
    (a) => a.status === "done" && a.conclusion === "success",
  ).length;
  // The run going now, or the one GitHub is about to start.
  const current = active ? report.attempts.find((a) => a.status !== "done") : undefined;
  const { bar } = providerStyle(report.provider);
  const warm = change(report.baseline.medianMs, report.warm.ms);
  const cold = change(report.baseline.medianMs, report.cold.ms);
  const runUsd = report.warm.usd ?? report.cold.usd;
  // Stopped or failed before every run finished: the numbers come from the runs that did.
  const partial = stopped ? finished : null;
  // Stopped by hand before any run finished: nothing to show but how to start again. A failed
  // evaluation keeps the page, so people see what a passing run would fill in.
  const empty = report.state === "cancelled" && finished === 0;
  // Failed before any run passed: the numbers wait on a passing run.
  const blocked = report.state === "failed" && finished === 0;
  // Shown with today's number while nothing can fill a tile.
  const needsRun = (today: string) => `Needs a passing run · today ${today}`;
  const ran = partial ?? (active ? finished : report.runs);
  const hasWarm = report.warm.ms !== null;
  const showWarm = hasWarm || active;
  const warmRuns = ran > 2 ? `runs 2–${ran}` : "run 2";
  const maxJob = Math.max(
    1,
    ...report.jobs.flatMap((j) =>
      (j.onProvider ? [j.baseline, j.cold, j.warm] : [j.baseline]).flatMap((s) =>
        s ? total(s) : [],
      ),
    ),
  );
  return (
    <div className="grid gap-6">
      {/* The signed-in page shows the run's details in its header (EvaluateHeader). */}
      {preview && <RunMeta report={report} />}

      {!active && <Dated report={report} />}
      {active && (
        <Progress report={report} finished={finished} editable={editable} onChange={onChange} />
      )}
      {stopped && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-xl border bg-card px-4 py-3 text-sm",
            report.state === "failed" && "border-destructive/40",
          )}
        >
          {report.state === "failed" ? (
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          ) : (
            <SquareIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span>
            {report.state === "failed"
              ? failedHeadline(report)
              : finished === 0
                ? "Stopped before run 1 finished."
                : `Stopped after ${finished} of ${report.runs} runs.`}{" "}
            <span className="text-muted-foreground">
              {finished === 0
                ? report.state === "failed"
                  ? `No run passed, so ${name}'s numbers below are still empty.`
                  : "No run finished, so there's nothing to compare yet."
                : finished === 1
                  ? "The numbers below are run 1's, with an empty cache; a warm number needs run 2."
                  : report.state === "failed"
                    ? `The numbers below come from the ${finished} runs that passed. More runs would give steadier numbers.`
                    : `The numbers below come from those ${finished}. More runs would give steadier numbers.`}
            </span>
          </span>
        </div>
      )}

      <SectionBoundary>
        {report.state === "failed" && <FailedJobs report={report} preview={preview} />}
      </SectionBoundary>

      {!empty && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Warm run"
            value={clock(report.warm.ms)}
            detail={
              warm
                ? `${warm.text} than ${clock(report.baseline.medianMs)} today`
                : blocked
                  ? needsRun(clock(report.baseline.medianMs))
                  : partial !== null
                    ? "Needs run 2"
                    : active
                      ? "After run 2"
                      : "Median of runs 2 on"
            }
          />
          <StatTile
            label="Cold run"
            value={clock(report.cold.ms)}
            detail={
              cold
                ? `${cold.text} · run 1, empty cache`
                : blocked
                  ? needsRun(clock(report.baseline.medianMs))
                  : active
                    ? "After run 1"
                    : "Run 1, empty cache"
            }
          />
          <StatTile
            label="Cost per run"
            value={usd(runUsd)}
            detail={
              finished === 0 && active
                ? `After run 1 · today ${usd(report.baseline.usd)}`
                : blocked
                  ? needsRun(usd(report.baseline.usd))
                  : costDetail(name, runUsd, report.baseline.usd)
            }
          />
          <StatTile
            label="Waiting for a runner"
            value={clock(report.warm.waitMs ?? report.cold.waitMs)}
            detail={
              finished === 0 && active
                ? `After run 1 · today ${clock(report.baseline.waitMs)}`
                : blocked
                  ? needsRun(clock(report.baseline.waitMs))
                  : `Median per job · today ${clock(report.baseline.waitMs)}`
            }
          />
        </div>
      )}

      <SectionBoundary>
        {!empty && <RunsChart report={report} current={current?.attempt ?? null} />}
      </SectionBoundary>

      <SectionBoundary>{current && <LiveRun report={report} attempt={current} />}</SectionBoundary>

      {(finished > 0 || blocked) && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
            <h3 className="font-semibold">By job</h3>
            <span className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[3px] bg-run/60" />
                Waiting for a runner
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[3px] bg-ink-2" />
                <span className={cn("-ml-1 inline-block size-2.5 rounded-[3px]", bar)} />
                Running
              </span>
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Today</th>
                <th className="px-4 py-2 font-medium">{name}, run 1 (cold)</th>
                {showWarm && (
                  <th className="px-4 py-2 font-medium">
                    {name}, {active ? `runs 2–${report.runs}` : warmRuns} (warm)
                  </th>
                )}
                <th className="px-4 py-2 text-right font-medium">
                  {hasWarm ? "Warm" : "Cold"} vs today
                </th>
              </tr>
            </thead>
            <tbody>
              {report.jobs.map((job) => {
                const ours = hasWarm ? job.warm : job.cold;
                const delta = change(job.baseline && total(job.baseline), ours && total(ours));
                return (
                  <tr key={job.name} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium whitespace-nowrap">
                      {job.name}
                      {!job.onProvider && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          Not on {name}: no relay
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <SplitCell split={job.baseline} max={maxJob} barClass="bg-ink-2" />
                    </td>
                    {job.onProvider ? (
                      <>
                        <td className="px-4 py-3">
                          <SplitCell split={job.cold} max={maxJob} barClass={bar} />
                        </td>
                        {showWarm && (
                          <td className="px-4 py-3">
                            <SplitCell
                              split={job.warm}
                              max={maxJob}
                              barClass={bar}
                              pending={active ? "After run 2" : undefined}
                            />
                          </td>
                        )}
                      </>
                    ) : (
                      // It kept its own runner during the evaluation, so its times say nothing
                      // about the provider and aren't compared.
                      <td colSpan={showWarm ? 2 : 1} className="px-4 py-3 text-muted-foreground">
                        Ran on its own runner, so there's nothing to compare. Add a relay to this
                        job to evaluate it on {name}.
                      </td>
                    )}
                    <td
                      className={cn(
                        "px-4 py-3 text-right whitespace-nowrap tabular-nums",
                        job.onProvider && delta && delta.pct < 0
                          ? "text-go"
                          : "text-muted-foreground",
                      )}
                    >
                      {(job.onProvider && delta?.text) || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(finished > 0 || blocked) && !preview && (
        <p className="max-w-3xl text-xs text-muted-foreground">
          Today is the median of the workflow's last {plural(report.baseline.runs, "passing run")}{" "}
          on {report.ref} over 14 days, on whatever runners they used and at whatever commit each
          ran. {name}'s runs ran back to back on one commit, so caches were warmer than on a typical
          day. {hasWarm && `Warm is the median of ${warmRuns}. `}Costs are list prices: each job's
          minutes, rounded up, at its runner's price per minute, with your own machines free. Free
          minutes, plan fees and discounts aren't counted.
        </p>
      )}
    </div>
  );
}

// Results is in the dashboard's first load (the signed-out Evaluate page shares it), and only a
// failed evaluation needs the failure reader, so it loads on demand.
const JobFailureSection = lazy(() =>
  import("@/components/job-failure").then((m) => ({ default: m.JobFailureSection })),
);

const isFailedAttempt = (a: Attempt) => a.status === "done" && a.conclusion !== "success";

const isFailedJob = (job: AttemptJob) =>
  job.conclusion === "failure" || job.conclusion === "timed_out";

/** The run that ended a failed evaluation, or undefined when GitHub refused before one ran. */
const failedAttempt = (report: EvaluationReport) => report.attempts.find(isFailedAttempt);

// GitHub's name for a self-hosted runner's job-started hook: the provider's own setup, which runs
// before any of the workflow's steps.
const RUNNER_SETUP = /^\d+\. Set up runner$/;

/** The banner's first sentence for a failed evaluation. */
function failedHeadline(report: EvaluationReport) {
  const attempt = failedAttempt(report);
  if (!attempt) return `Stopped: ${report.error ?? "a run failed."}`;
  const jobs = attempt.jobs.filter(isFailedJob);
  const what =
    jobs.length === 1
      ? `${jobs[0]!.name} failed`
      : jobs.length > 1
        ? `${plural(jobs.length, "job")} failed`
        : attempt.conclusion === "cancelled"
          ? "it was cancelled"
          : "it failed";
  return `Run ${attempt.attempt} stopped the evaluation: ${what}.`;
}

/**
 * Why the run that ended the evaluation failed: each failed job's failed step, GitHub's
 * annotations and the end of its log, read from GitHub as in History, so nobody has to dig through
 * GitHub to find it. A job the provider failed in its own setup says so: that's the provider
 * account, not the workflow.
 */
function FailedJobs({ report, preview }: { report: EvaluationReport; preview?: boolean }) {
  const attempt = failedAttempt(report);
  const jobs = attempt?.jobs.filter(isFailedJob) ?? [];
  if (!report.runId || jobs.length === 0) return null;
  const { name } = providerInfo(report.provider);
  return (
    <div className="grid gap-3">
      {jobs.map((job) => {
        const url = jobUrl(report, job.id);
        const refused =
          job.onProvider && job.failedStep !== null && RUNNER_SETUP.test(job.failedStep);
        return (
          <div key={job.id} className="grid gap-3 rounded-xl border bg-card px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                {job.name}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {job.onProvider ? `On ${name}` : "Not on " + name + ": no relay"}
                </span>
              </h3>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                On GitHub
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            </div>
            {refused && (
              <p className="text-sm">
                {name} stopped this job in its own setup, before any of your workflow's steps ran.
                That's usually something on your {name} account, such as its plan, rather than your
                workflow.
              </p>
            )}
            {!preview && (
              <Suspense fallback={<div aria-busy className="h-32 rounded-lg border" />}>
                <JobFailureSection jobId={job.id} logUrl={url} hideCause={refused} compact />
              </Suspense>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * An evaluation past RECENT_DAYS: still readable from its link, but the provider's real runs are the
 * better guide by now, so point there.
 */
function Dated({ report }: { report: EvaluationReport }) {
  const age = Date.now() - report.createdAt;
  if (age < RECENT_DAYS * 86_400_000) return null;
  const { name } = providerInfo(report.provider);
  const weeks = Math.floor(age / (7 * 86_400_000));
  const routed = report.routedRuns ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
      <ClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        {routed > 0
          ? `From ${weeks} weeks ago. ${name} has run this workflow ${plural(routed, "time")} since.`
          : `From ${weeks} weeks ago. These numbers may be out of date.`}
      </span>
      {routed > 0 ? (
        <Button variant="outline" size="sm" asChild>
          <Link
            to="/performance/workflow"
            search={{ repo: report.repositoryId, workflow: report.workflow ?? undefined }}
          >
            See it on Performance
            <ArrowRightIcon />
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" asChild>
          <Link to="/providers/$provider/evaluate" params={{ provider: report.provider }}>
            <RotateCcwIcon />
            Evaluate again
          </Link>
        </Button>
      )}
    </div>
  );
}

/** Time left, and the Skip and Stop buttons, while the runs go. */
function Progress({
  report,
  finished,
  editable,
  onChange,
}: {
  report: EvaluationReport;
  finished: number;
  editable: boolean;
  onChange: () => void;
}) {
  // A run's length: the provider's own once one has finished, else how long it takes today.
  const perRun = report.warm.ms ?? report.cold.ms ?? report.baseline.medianMs;
  const left = perRun !== null ? perRun * (report.runs - finished) : null;
  const [busy, setBusy] = useState(false);
  const act = (call: () => Promise<unknown>) => () => {
    setBusy(true);
    void call().then(onChange, onChange);
  };
  return (
    <div className="grid gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-64 flex-1 items-start gap-2">
          <ClockIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-run" />
          <div className="grid gap-0.5">
            <span className="font-medium">
              {left !== null ? `About ${about(left)} left` : "Working out the time left"}
              <span className="font-normal text-muted-foreground">
                {" "}
                · run {Math.min(finished + 1, report.runs)} of {report.runs}
                {perRun !== null && `, about ${about(perRun)} each`}
              </span>
            </span>
            <span className="text-muted-foreground">
              {finished === 0
                ? "The numbers below fill in as runs finish. You can leave; the runs carry on."
                : `${plural(finished, "run")} in. Stop whenever you've seen enough; finished runs are kept.`}
            </span>
          </div>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={act(() => cancelEvaluation(report.id))}
            >
              <SquareIcon />
              {finished > 0 ? `Stop at ${plural(finished, "run")}` : "Stop"}
            </Button>
          </div>
        )}
      </div>
      <div className="flex gap-1">
        {report.attempts.map((a) => (
          <span
            key={a.attempt}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              a.status === "done"
                ? providerStyle(report.provider).bar
                : a.attempt === finished + 1
                  ? "animate-pulse bg-run/60"
                  : "bg-raised-2",
            )}
          />
        ))}
      </div>
    </div>
  );
}

/** The run going now: its jobs as they queue, run and finish. */
function LiveRun({ report, attempt }: { report: EvaluationReport; attempt: Attempt }) {
  const url = report.runId ? runUrl(report, attempt.attempt) : null;
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-run" />
          Run {attempt.attempt} now
          <span className="font-normal text-muted-foreground">
            {attempt.attempt === 1 ? "Cold cache" : "Warm"}
          </span>
        </h3>
        {url && attempt.status !== "waiting" && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            On GitHub
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </a>
        )}
      </div>
      {attempt.jobs.length === 0 ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          {report.runId
            ? `Waiting for GitHub to start run ${attempt.attempt}. Jobs show up here once runners pick them up.`
            : "Asking GitHub to start the workflow."}
        </p>
      ) : (
        <ul className="grid gap-2 border-t px-4 py-3 text-sm">
          {attempt.jobs.map((job) => (
            <li key={job.name} className="flex items-center gap-2">
              {job.status === "done" && (
                <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
              )}
              {job.status === "running" && (
                <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-run" />
              )}
              {job.status === "queued" && (
                <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground" />
              )}
              <span className="flex-1">{job.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {job.split
                  ? clock(job.split.waitMs + job.split.runMs)
                  : job.status === "queued"
                    ? "Queued"
                    : "Running"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SplitCell({
  split,
  max,
  barClass,
  pending,
}: {
  split: Split | null;
  max: number;
  barClass: string;
  /** Shown instead of a dash while the number is still to come. */
  pending?: string;
}) {
  if (!split) return <span className="text-muted-foreground">{pending ?? "—"}</span>;
  return (
    <div className="grid min-w-32 gap-1.5">
      <span className="flex items-baseline justify-between gap-2 tabular-nums">
        <span>{clock(total(split))}</span>
        <span className="text-xs text-muted-foreground">wait {clock(split.waitMs)}</span>
      </span>
      <span className="flex h-2 w-full overflow-hidden rounded-full bg-raised-2">
        <span className="h-full bg-run/60" style={{ width: `${(split.waitMs / max) * 100}%` }} />
        <span
          className={cn("h-full", barClass)}
          style={{ width: `${(split.runMs / max) * 100}%` }}
        />
      </span>
    </div>
  );
}

// Small, fixed nudges so the silhouettes of runs still to come don't line up exactly.
const WOBBLE = [1, 0.93, 1.06, 0.95, 1.07];

/**
 * How tall to draw each run that hasn't finished, in ms: about as long as the run before it. Run 1
 * guesses a little under today's median, and run 2, the first warm one, a little under run 1.
 */
function silhouettes(report: EvaluationReport) {
  const heights: number[] = [];
  let previous: number | null = null;
  for (const a of report.attempts) {
    if (a.ms !== null) {
      previous = a.ms;
      heights.push(a.ms);
      continue;
    }
    const guess: number =
      previous === null
        ? (report.baseline.medianMs ?? 300_000) * 0.92
        : a.attempt === 2
          ? previous * 0.85
          : previous * WOBBLE[a.attempt % WOBBLE.length]!;
    heights.push(guess);
    previous = guess;
  }
  return heights;
}

function RunsChart({ report, current }: { report: EvaluationReport; current: number | null }) {
  const notRunLabel = report.state === "cancelled" || report.state === "failed" ? "Not run" : null;
  const { name } = providerInfo(report.provider);
  const { bar } = providerStyle(report.provider);
  const baseline = report.baseline.medianMs;
  const heights = current !== null ? silhouettes(report) : [];
  const max =
    Math.max(baseline ?? 0, ...report.attempts.map((a) => a.ms ?? 0), ...heights, 1) * 1.15;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Each run, start to finish</h3>
        <span className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className={cn("inline-block size-2.5 rounded-[3px]", bar)} />
            {name}
          </span>
          {baseline !== null && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0 w-4 border-t-2 border-dashed border-ink-2" />
              Today's median
            </span>
          )}
        </span>
      </div>
      <div className="relative flex h-44 items-end gap-4 border-b pl-1 sm:gap-8">
        {baseline !== null && (
          <span
            className="absolute inset-x-0 border-t-2 border-dashed border-ink-2"
            style={{ bottom: `${(baseline / max) * 100}%` }}
          >
            {/* The median's value on the line itself, at the right end, clear of the bars. */}
            <span className="absolute right-0 bottom-1 rounded bg-card px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
              Today {clock(baseline)}
            </span>
          </span>
        )}
        {report.attempts.map((a) => (
          <div key={a.attempt} className="flex h-full flex-1 flex-col items-center justify-end">
            {a.status !== "done" && current !== null ? (
              // A run still to come: a dashed silhouette about as tall as the run before it.
              <span
                className={cn(
                  "flex w-full max-w-14 items-start justify-center rounded-t-md border-2 border-b-0 border-dashed pt-2",
                  a.attempt === current ? "border-run/60 bg-run/10" : "border-ink-2/40 bg-raised",
                )}
                style={{ height: `${((heights[a.attempt - 1] ?? 0) / max) * 100}%` }}
              >
                {a.attempt === current && (
                  <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-run" />
                )}
              </span>
            ) : (
              <span
                className={cn(
                  "w-full max-w-14 rounded-t-md",
                  isFailedAttempt(a) ? "bg-destructive/60" : [bar, a.attempt === 1 && "opacity-50"],
                )}
                style={{ height: `${((a.ms ?? 0) / max) * 100}%` }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-4 pl-1 text-center text-xs text-muted-foreground sm:gap-8">
        {report.attempts.map((a) => (
          <span key={a.attempt} className="flex-1">
            {/* Under the axis, so a bar near the median line never hides its time. */}
            <span className="block text-sm font-medium text-foreground tabular-nums">
              {isFailedAttempt(a)
                ? "Failed"
                : a.ms !== null
                  ? clock(a.ms)
                  : a.attempt === current
                    ? a.status === "waiting"
                      ? "Starting"
                      : "Running"
                    : notRunLabel !== null
                      ? notRunLabel
                      : current !== null
                        ? "Queued"
                        : "—"}
            </span>
            {a.usd !== null && (
              <span className="block text-foreground tabular-nums">{usd(a.usd)}</span>
            )}
            Run {a.attempt}
            <br />
            {a.attempt === 1 ? "Cold cache" : "Warm"}
          </span>
        ))}
      </div>
    </div>
  );
}
