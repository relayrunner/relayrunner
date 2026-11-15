import { sizeText } from "@relayrunner/providers";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { CopyButton } from "@/components/add-runner";
import { providerOf, providerStyle, RunnerMark } from "@/components/providers";
import { TimeRangePicker } from "@/components/range-picker";
import { withRunner } from "@/components/runner-panel-link";
import { Facts, LINK, Links } from "@/components/run-sheet";
import { StatusIcon } from "@/components/status-icon";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { timeAgo } from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import { clock, DAY_MS, HOUR_MS, plural } from "@/lib/job-times";
import { cachedMachine, type Machine, workspaceMachine } from "@/lib/machines";
import { onlineSpans, type RunnerBucket } from "@/lib/runner-days";
import { getRunnerReport, type RunnerReport, sampleRunnerReport } from "@/lib/runner-report";
import { isLongWait, runParam } from "@/lib/runs";
import { unlessDefault, useSetSearch } from "@/lib/search-params";
import {
  type RangeOptions,
  rangePhrase,
  resolveRange,
  shortDate,
  type TimeRange,
} from "@/lib/time-range";
import { minutes } from "@/lib/usage";
import { cn, count, percent } from "@/lib/utils";

/**
 * The panel's ranges, down to the past hour, with bars per 15 minutes, per hour or per day. They
 * reach back 30 days, as far as Performance does.
 */
export const RUNNER_RANGES: RangeOptions = {
  presets: ["1h", "3h", "24h", "2d", "7d", "14d", "30d", "today", "yesterday", "week", "lastweek"],
  customDays: 30,
};
export const RUNNER_DEFAULT_RANGE: TimeRange = "14d";
const MACHINE = "machine:";

// The last reports read, by runner and range, so reopening a runner shows it at once.
const reports = new Map<string, Promise<RunnerReport>>();

function loadReport(key: string, range: TimeRange) {
  const id = `${key}\u001f${range}`;
  let request = reports.get(id);
  if (!request) {
    const window = resolveRange(range);
    request = authDisabled
      ? Promise.resolve(sampleRunnerReport(key, window))
      : getRunnerReport(key, window);
    request.catch(() => reports.delete(id));
    reports.set(id, request);
    // A window that runs to now is kept for a minute, since a runner's numbers move as it takes
    // jobs. One that's over, such as yesterday, stays put.
    if (window.to > Date.now() - 60_000)
      setTimeout(() => reports.get(id) === request && reports.delete(id), 60_000);
  }
  return request;
}

/**
 * One runner's detail panel: its times, jobs per day, when it was online (a connected machine) and
 * the jobs it ran last. Which runner is open lives in the URL (`?runner=`), so any page can open
 * it and the back button steps out of it.
 */
export function RunnerSheet({ runnerKey, range }: { runnerKey: string; range: TimeRange }) {
  const navigate = useNavigate();
  const close = () => void navigate({ to: ".", search: withRunner() });
  const setSearch = useSetSearch<{ runnerRange?: TimeRange }>();
  const setRange = (next: TimeRange) =>
    setSearch({ runnerRange: unlessDefault(next, RUNNER_DEFAULT_RANGE) });
  // The report shown, with the range it's for: the last one stays up while another loads.
  const [shown, setShown] = useState<{ range: TimeRange; report: RunnerReport } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    loadReport(runnerKey, range)
      .then((report) => live && setShown({ range, report }))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [runnerKey, range]);
  const machine = useMachine(runnerKey);

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent aria-describedby={undefined} widthKey="runner-panel-width">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-5 py-5 sm:px-6">
          {failed ? (
            <>
              <SheetTitle className="sr-only">Runner</SheetTitle>
              <p className="pt-8 text-sm text-muted-foreground">
                Couldn't load this runner. Try again in a moment.
              </p>
            </>
          ) : !shown ? (
            <Placeholder />
          ) : (
            <RunnerView
              report={shown.report}
              machine={machine}
              reportRange={shown.range}
              range={range}
              onRange={setRange}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// A machine's live state from the workspace's machines, for whether it's online now.
function useMachine(key: string) {
  const id = key.startsWith(MACHINE) ? key.slice(MACHINE.length) : null;
  const [machine, setMachine] = useState<Machine | null>(() => (id && cachedMachine(id)) || null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    workspaceMachine(id)
      .then((found) => live && setMachine(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  return machine;
}

function RunnerView({
  report,
  machine,
  reportRange,
  range,
  onRange,
}: {
  report: RunnerReport;
  machine: Machine | null;
  /** The range `report` is for, which lags `range` while another loads. */
  reportRange: TimeRange;
  range: TimeRange;
  onRange: (range: TimeRange) => void;
}) {
  const loading = reportRange !== range;
  const { environment: env, stat, missed } = report;
  const provider = providerOf(env);
  const detail = [env.detail, sizeText(env.size)].filter(Boolean).join(" · ");
  const sent = stat.runs + missed;
  const phrase = rangePhrase(reportRange);

  return (
    <>
      <header className="grid gap-1 pr-8">
        <SheetTitle className="flex items-center gap-2.5">
          <RunnerMark runner={env} />
          <span className="min-w-0 break-words">{env.label}</span>
        </SheetTitle>
        {detail && <SheetDescription className="pl-[38px]">{detail}</SheetDescription>}
        {machine && <Labels machine={machine} />}
      </header>

      <div className={cn("grid gap-6 transition-opacity", loading && "opacity-60")}>
        <TimeRangePicker
          {...RUNNER_RANGES}
          value={range}
          onChange={onRange}
          className="justify-self-start"
        />
        <Facts
          className="sm:grid-cols-4"
          items={[
            [
              "Jobs",
              <>
                {count(stat.runs)}
                {missed > 0 && (
                  <span
                    className="block text-xs text-muted-foreground"
                    title={`Started ${percent(stat.runs / sent)} of the jobs sent here`}
                  >
                    {missed} not picked up
                  </span>
                )}
              </>,
            ],
            ["Success", stat.runs ? percent(stat.successes / stat.runs) : "—"],
            ["Median wait", clock(stat.waitMs)],
            ["Median run", clock(stat.medianMs)],
          ]}
        />

        {report.connections && <Uptime report={report} phrase={phrase} machine={machine} />}
        <Throughput report={report} phrase={phrase} />
        <RecentJobs report={report} />
      </div>

      <Links>
        <Link to="/performance" search={{ view: "runners" }} className={LINK}>
          Compare runners in Performance
          <ChevronRightIcon aria-hidden className="size-3.5" />
        </Link>
        {provider === "machine" ? (
          <Link to="/runners" className={LINK}>
            Open in Runners
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Link>
        ) : (
          <Link to="/providers/$provider" params={{ provider }} className={LINK}>
            Your usage on {providerStyle(provider).name}
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Link>
        )}
      </Links>
    </>
  );
}

/**
 * A self-hosted runner's labels, as GitHub lists them: the ones a job's `runs-on` or `machine:`
 * matches, then the one RelayRunner added to route jobs to a runner added from GitHub.
 */
function Labels({ machine }: { machine: Machine }) {
  const labels = [
    ...(machine.labels ?? []),
    ...(machine.routingLabel ? [machine.routingLabel] : []),
  ];
  if (labels.length === 0) return null;
  return (
    <p className="flex items-center gap-1 pl-[38px] text-xs text-muted-foreground">
      <span className="min-w-0 font-mono break-words">{labels.join(", ")}</span>
      <CopyButton text={labels.join(", ")} label="Copy labels" className="-my-1.5 shrink-0" />
    </p>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside && <span className="text-xs text-muted-foreground tabular-nums">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A time as "3:00 PM" today, or "Nov 13, 3:00 PM" on another day. */
function timeLabel(ms: number) {
  const time = timeFormat.format(ms);
  return new Date(ms).toDateString() === new Date().toDateString()
    ? time
    : `${shortDate(ms)}, ${time}`;
}

/** When a bar starts, as its tooltip and the busiest line name it. */
const barLabel = (start: number, bucketMs: number) =>
  bucketMs >= DAY_MS ? shortDate(start) : timeLabel(start);

/** What each bar counts, for the chart's title. */
const perBar = (bucketMs: number) =>
  bucketMs >= DAY_MS ? "day" : bucketMs >= HOUR_MS ? "hour" : "15 minutes";

/**
 * A strip across the window, filled where the machine was online. It starts where the jobs
 * chart's first bar does, so the two line up.
 */
function Uptime({
  report,
  phrase,
  machine,
}: {
  report: RunnerReport;
  phrase: string;
  machine: Machine | null;
}) {
  const { to } = report;
  const from = report.buckets[0]!.start;
  const now = Date.now();
  const spans = onlineSpans(
    report.connections ?? [],
    {
      online: Boolean(machine?.status?.online),
      connectedAt: machine?.status?.connectedAt ?? null,
      lastSeenAt: machine?.lastSeenAt ? Date.parse(machine.lastSeenAt) : null,
    },
    from,
    now,
    to,
  );
  const onlineMs = spans.reduce((sum, [start, end]) => sum + (end - start), 0);
  const span = to - from;
  const share = percent(onlineMs / span);
  return (
    <Section title="Online" aside={`${share} of ${phrase}`}>
      <div
        role="img"
        aria-label={`Online ${share} of the time`}
        className="relative h-3 overflow-hidden rounded-sm bg-secondary"
      >
        {spans.map(([start, end]) => (
          <span
            key={start}
            title={`${new Date(start).toLocaleString()} to ${
              end >= now - 60_000 ? "now" : new Date(end).toLocaleString()
            }`}
            className="absolute inset-y-0 min-w-px bg-go"
            style={{
              left: `${((start - from) / span) * 100}%`,
              width: `${((end - start) / span) * 100}%`,
            }}
          />
        ))}
      </div>
      <Axis from={from} to={to} />
    </Section>
  );
}

/** The window's two ends under a chart: days, or times of day for a window under two days. */
function Axis({ from, to }: { from: number; to: number }) {
  const now = Date.now();
  const short = to - from <= 2 * DAY_MS;
  const label = short ? timeLabel : shortDate;
  return (
    <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
      <span>{label(from)}</span>
      <span>{to >= now - 60_000 ? (short ? "Now" : "Today") : label(to - 1)}</span>
    </div>
  );
}

/** Jobs per bar, failures stacked on top, with the time spent running them. */
function Throughput({ report, phrase }: { report: RunnerReport; phrase: string }) {
  const bars = report.buckets;
  const busyMs = bars.reduce((sum, bar) => sum + bar.busyMs, 0);
  const most = Math.max(1, ...bars.map((bar) => bar.jobs));
  const busiest = bars.reduce<RunnerBucket | null>(
    (best, bar) => (bar.jobs > (best?.jobs ?? 0) ? bar : best),
    null,
  );
  const title = `Jobs per ${perBar(report.bucketMs)}`;
  return (
    <Section title={title} aside={`${minutes(busyMs / 60_000)} min running jobs`}>
      {report.stat.runs === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs in {phrase}.</p>
      ) : (
        <>
          <div className="flex h-24 items-end gap-[2px]" role="img" aria-label={title}>
            {bars.map((bar) => {
              const ok = bar.jobs - bar.failures;
              return (
                <div
                  key={bar.start}
                  title={`${barLabel(bar.start, report.bucketMs)}: ${plural(bar.jobs, "job")}${
                    bar.failures ? `, ${bar.failures} failed` : ""
                  } · ${minutes(bar.busyMs / 60_000)} min`}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[2px] hover:bg-secondary/60"
                >
                  {bar.failures > 0 && (
                    <span
                      className="block bg-destructive/80"
                      style={{ height: `${(bar.failures / most) * 100}%` }}
                    />
                  )}
                  <span
                    className={cn("block bg-go/70", bar.jobs === 0 && "h-px bg-border")}
                    style={bar.jobs ? { height: `${(ok / most) * 100}%` } : undefined}
                  />
                </div>
              );
            })}
          </div>
          <Axis from={bars[0]!.start} to={report.to} />
          {busiest && (
            <p className="text-xs text-muted-foreground">
              Busiest {report.bucketMs >= DAY_MS ? "on" : "at"}{" "}
              {barLabel(busiest.start, report.bucketMs)} with {plural(busiest.jobs, "job")}.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function RecentJobs({ report }: { report: RunnerReport }) {
  if (!report.recent.length) return null;
  return (
    <Section title="Recent jobs">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm tabular-nums">
          <thead className="bg-secondary/40">
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-4 pl-3 text-left font-normal">
                Job
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-normal">
                Wait
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-normal">
                Run
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">
                Finished
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report.recent.map((job) => {
              const wait = job.queuedAt === null ? null : job.startedAt - job.queuedAt;
              return (
                <tr key={job.id} className="hover:bg-secondary/30">
                  <th scope="row" className="py-2 pr-4 pl-3 text-left font-normal">
                    <Link
                      to="/history"
                      search={{ run: runParam(job), job: job.id }}
                      className="group inline-flex min-w-0 items-start gap-2"
                    >
                      <StatusIcon
                        status="completed"
                        conclusion={job.conclusion ?? "unknown"}
                        className="mt-0.5 size-4"
                      />
                      <span className="min-w-0">
                        <span className="block underline-offset-4 group-hover:underline">
                          {job.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {[job.workflow, job.repository].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </Link>
                  </th>
                  <td
                    className={cn(
                      "py-2 pr-4 text-right align-top whitespace-nowrap",
                      isLongWait(wait) && "font-semibold text-run",
                    )}
                  >
                    {clock(wait)}
                  </td>
                  <td className="py-2 pr-4 text-right align-top whitespace-nowrap">
                    {clock(job.completedAt - job.startedAt)}
                  </td>
                  <td className="py-2 pr-3 text-right align-top whitespace-nowrap text-muted-foreground">
                    {timeAgo(job.completedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Holds the panel's space while the report loads. */
function Placeholder() {
  return (
    <div aria-busy aria-label="Loading runner" className="grid gap-6">
      <SheetTitle className="sr-only">Runner</SheetTitle>
      <div className="grid gap-2 pr-8">
        <span className="h-5 w-56 max-w-full rounded-sm bg-secondary" />
        <span className="h-3 w-40 rounded-sm bg-secondary" />
      </div>
      <div className="h-14 rounded-lg border" />
      <div className="h-24 rounded-lg bg-secondary/40" />
      <div className="grid rounded-lg border">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-10 items-center gap-4 px-3">
            <span className="h-3 w-40 max-w-[50%] rounded-sm bg-secondary" />
          </div>
        ))}
      </div>
    </div>
  );
}
