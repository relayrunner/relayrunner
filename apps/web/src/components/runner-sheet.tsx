import { sizeText } from "@relayrunner/providers";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { providerOf, providerStyle, RunnerMark } from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { withRunner } from "@/components/runner-panel-link";
import { Facts, LINK, Links } from "@/components/run-sheet";
import { StatusIcon } from "@/components/status-icon";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { timeAgo } from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import { clock, plural } from "@/lib/job-times";
import { cachedMachine, type Machine, workspaceMachine } from "@/lib/machines";
import { everyDay, onlineSpans, type RunnerDay } from "@/lib/runner-days";
import { getRunnerReport, type RunnerReport, sampleRunnerReport } from "@/lib/runner-report";
import { isLongWait, runParam } from "@/lib/runs";
import { unlessDefault, useSetSearch } from "@/lib/search-params";
import { minutes } from "@/lib/usage";
import { cn, count, percent } from "@/lib/utils";

export const RUNNER_RANGES = [7, 14, 30] as const;
export const RUNNER_DEFAULT_DAYS = 14;
const MACHINE = "machine:";

// The last reports read, by runner and range, so reopening a runner shows it at once.
const reports = new Map<string, Promise<RunnerReport>>();

function loadReport(key: string, days: number) {
  const id = `${key}\u001f${days}`;
  let request = reports.get(id);
  if (!request) {
    request = authDisabled
      ? Promise.resolve(sampleRunnerReport(key, days))
      : getRunnerReport(key, days);
    request.catch(() => reports.delete(id));
    reports.set(id, request);
    // Kept for a minute: a runner's numbers move as it takes jobs.
    setTimeout(() => reports.get(id) === request && reports.delete(id), 60_000);
  }
  return request;
}

/**
 * One runner's detail panel: its times, jobs per day, when it was online (a connected machine) and
 * the jobs it ran last. Which runner is open lives in the URL (`?runner=`), so any page can open
 * it and the back button steps out of it.
 */
export function RunnerSheet({ runnerKey, days }: { runnerKey: string; days: number }) {
  const navigate = useNavigate();
  const close = () => void navigate({ to: ".", search: withRunner() });
  const setSearch = useSetSearch<{ runnerDays?: number }>();
  const setDays = (next: number) =>
    setSearch({ runnerDays: unlessDefault(next, RUNNER_DEFAULT_DAYS) });
  const [report, setReport] = useState<RunnerReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    loadReport(runnerKey, days)
      .then((value) => live && setReport(value))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [runnerKey, days]);
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
          ) : !report ? (
            <Placeholder />
          ) : (
            <RunnerView
              report={report}
              machine={machine}
              days={days}
              onDays={setDays}
              loading={report.days !== days}
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
  days,
  onDays,
  loading,
}: {
  report: RunnerReport;
  machine: Machine | null;
  days: number;
  onDays: (days: number) => void;
  loading: boolean;
}) {
  const { environment: env, stat, missed } = report;
  const provider = providerOf(env);
  const detail = [env.detail, sizeText(env.size)].filter(Boolean).join(" · ");
  const sent = stat.runs + missed;
  const byDay = useMemo(() => everyDay(report), [report]);

  return (
    <>
      <header className="grid gap-1 pr-8">
        <SheetTitle className="flex items-center gap-2.5">
          <RunnerMark runner={env} />
          <span className="min-w-0 break-words">{env.label}</span>
        </SheetTitle>
        {detail && <SheetDescription className="pl-[38px]">{detail}</SheetDescription>}
      </header>

      <div className={cn("grid gap-6 transition-opacity", loading && "opacity-60")}>
        <RangePicker ranges={RUNNER_RANGES} days={days} onChange={onDays} />
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

        {report.connections && <Uptime report={report} since={byDay[0]!.day} machine={machine} />}
        <Throughput report={report} days={byDay} />
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

const dayLabel = (day: number) =>
  new Date(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A strip across the window, filled where the machine was online. */
// From `since`, the first day the jobs chart shows, so the two line up.
function Uptime({
  report,
  since,
  machine,
}: {
  report: RunnerReport;
  since: number;
  machine: Machine | null;
}) {
  const now = Date.now();
  const spans = onlineSpans(
    report.connections ?? [],
    {
      online: Boolean(machine?.status?.online),
      connectedAt: machine?.status?.connectedAt ?? null,
      lastSeenAt: machine?.lastSeenAt ? Date.parse(machine.lastSeenAt) : null,
    },
    since,
    now,
  );
  const onlineMs = spans.reduce((sum, [from, to]) => sum + (to - from), 0);
  const span = now - since;
  const share = percent(onlineMs / span);
  return (
    <Section title="Online" aside={`${share} of the last ${plural(report.days, "day")}`}>
      <div
        role="img"
        aria-label={`Online ${share} of the time`}
        className="relative h-3 overflow-hidden rounded-sm bg-secondary"
      >
        {spans.map(([from, to]) => (
          <span
            key={from}
            title={`${new Date(from).toLocaleString()} to ${
              to >= now - 60_000 ? "now" : new Date(to).toLocaleString()
            }`}
            className="absolute inset-y-0 min-w-px bg-go"
            style={{
              left: `${((from - since) / span) * 100}%`,
              width: `${((to - from) / span) * 100}%`,
            }}
          />
        ))}
      </div>
      <Axis from={since} />
    </Section>
  );
}

function Axis({ from }: { from: number }) {
  return (
    <div className="flex justify-between text-[11px] text-muted-foreground">
      <span>{dayLabel(from)}</span>
      <span>Today</span>
    </div>
  );
}

/** Jobs per day as bars, failures stacked on top, with the time spent running them. */
function Throughput({ report, days }: { report: RunnerReport; days: RunnerDay[] }) {
  const busyMs = days.reduce((sum, day) => sum + day.busyMs, 0);
  const most = Math.max(1, ...days.map((day) => day.jobs));
  const busiest = days.reduce<RunnerDay | null>(
    (best, day) => (day.jobs > (best?.jobs ?? 0) ? day : best),
    null,
  );
  return (
    <Section title="Jobs per day" aside={`${minutes(busyMs / 60_000)} min running jobs`}>
      {report.stat.runs === 0 ? (
        <p className="text-sm text-muted-foreground">
          No jobs in the last {plural(report.days, "day")}.
        </p>
      ) : (
        <>
          <div className="flex h-24 items-end gap-[2px]" role="img" aria-label="Jobs per day">
            {days.map((day) => {
              const ok = day.jobs - day.failures;
              return (
                <div
                  key={day.day}
                  title={`${dayLabel(day.day)}: ${plural(day.jobs, "job")}${
                    day.failures ? `, ${day.failures} failed` : ""
                  } · ${minutes(day.busyMs / 60_000)} min`}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[2px] hover:bg-secondary/60"
                >
                  {day.failures > 0 && (
                    <span
                      className="block bg-destructive/80"
                      style={{ height: `${(day.failures / most) * 100}%` }}
                    />
                  )}
                  <span
                    className={cn(
                      "block bg-muted-foreground/60",
                      day.jobs === 0 && "h-px bg-border",
                    )}
                    style={day.jobs ? { height: `${(ok / most) * 100}%` } : undefined}
                  />
                </div>
              );
            })}
          </div>
          <Axis from={days[0]!.day} />
          {busiest && (
            <p className="text-xs text-muted-foreground">
              Busiest on {dayLabel(busiest.day)} with {plural(busiest.jobs, "job")}.
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
