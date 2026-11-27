// The panel listing the runs behind one signal row.
import { type ReactNode, useEffect, useState } from "react";
import { CommitBy } from "@/components/commit";
import { ExternalLink, RunLink } from "@/components/run-sheet";
import { RunnerLink } from "@/components/runner-link";
import { StatusIcon } from "@/components/status-icon";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { timeAgo } from "@/lib/activity";
import {
  getSignalRuns,
  type SignalFilter,
  type SignalRow,
  type SignalRowRef,
  type SignalRun,
  type SignalRunsReport,
  SIGNAL_COPY,
  triggerName,
} from "@/lib/signals";
import { useSetSearch } from "@/lib/search-params";
import { plural } from "@/lib/job-times";
import { dayPreset, rangeDays, rangePhrase, type TimeRange } from "@/lib/time-range";
import { count, elapsed } from "@/lib/utils";
import { type Search } from "@/features/signals/search";
import { SubjectText, workflowUrl, SignalLinks } from "@/features/signals/signal-card";

// Signal time for one run: seconds under a minute, else whole minutes (CI time never reads in hours).
const runTime = (ms: number) => (ms < 60_000 ? elapsed(ms) : `${count(Math.round(ms / 60_000))}m`);

// The runs behind one signal row, newest first, each opening in History's panel.
// Keyed on the row, range and filter, so it loads once.
export function RunsPanel({
  row,
  listed,
  range,
  filter,
}: {
  row: SignalRowRef;
  /** The row as the page lists it, when it does. */
  listed: SignalRow | undefined;
  range: TimeRange;
  filter: SignalFilter;
}) {
  const setSearch = useSetSearch<Search>();
  const close = () => setSearch({ signal: undefined, in: undefined, subject: undefined });
  const [found, setFound] = useState<SignalRunsReport | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    const request = getSignalRuns(row, range, filter);
    request.then(
      (next) => live && setFound(next),
      () => live && setFound("failed"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the row
  }, []);

  const copy = SIGNAL_COPY[row.signal];
  // Runs come from single jobs, so a longer range lists only its last 30 days.
  const span =
    found && found !== "failed" && found.days < rangeDays(range)
      ? rangePhrase(dayPreset(found.days))
      : rangePhrase(range);

  let body: ReactNode;
  if (found === "failed")
    body = (
      <p className="text-sm text-muted-foreground">
        Couldn't load these runs. Try again in a moment.
      </p>
    );
  else if (!found)
    body = (
      <div aria-busy aria-label="Loading runs" className="grid gap-3">
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} className="h-9 rounded-sm bg-secondary/60" />
        ))}
      </div>
    );
  else if (!found.runs.length)
    body = <p className="text-sm text-muted-foreground">No runs behind this row in {span}.</p>;
  else
    body = (
      <div className="grid gap-2">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {plural(found.total, "run")} in {span}
          </span>
          <span>{copy.minutes}</span>
        </div>
        <ul className="divide-y rounded-lg border">
          {found.runs.map((run) => (
            <RunItem key={`${run.runId}-${run.runAttempt}`} run={run} />
          ))}
        </ul>
        {found.total > found.runs.length && (
          <p className="text-xs text-muted-foreground">
            The newest {found.runs.length} of {count(found.total)}.
          </p>
        )}
      </div>
    );

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent aria-describedby={undefined} widthKey="signal-runs-width">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-5 py-5 sm:px-6">
          <header className="grid gap-1 pr-8">
            <SheetTitle>{copy.title}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 truncate">
                <SubjectText repository={row.repository} name={row.subject} />
              </span>
              {listed?.workflowPath && (
                <ExternalLink href={workflowUrl(row.repository, listed.workflowPath)}>
                  Workflow file
                </ExternalLink>
              )}
              {listed?.runnerKey && (
                <RunnerLink
                  runner={{ key: listed.runnerKey, label: "Runner" }}
                  className="inline-flex items-center gap-1.5"
                  markClassName="size-3.5"
                />
              )}
            </SheetDescription>
          </header>
          {/* What the signal means, so the runs below read in context. */}
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">{copy.about}</p>
            <SignalLinks id={row.signal} />
          </div>
          {body}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RunItem({ run }: { run: SignalRun }) {
  return (
    <li>
      <RunLink
        run={run}
        job={run.jobId ?? undefined}
        className="group flex items-start gap-3 px-3 py-2.5 hover:bg-secondary/30"
      >
        <StatusIcon
          status="completed"
          conclusion={run.conclusion ?? "unknown"}
          className="mt-0.5 size-4"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm underline-offset-4 group-hover:underline">
            {run.title ?? run.workflow ?? `Run ${run.runId}`}
          </span>
          <span className="flex flex-wrap items-center gap-x-2.5 text-xs text-muted-foreground">
            <span>
              {[run.event && triggerName(run.event), run.branch].filter(Boolean).join(" on ")}
            </span>
            <CommitBy actor={run.actor} sha={run.sha} />
            {run.startedAt !== null && <span>{timeAgo(run.startedAt)}</span>}
          </span>
        </span>
        <span className="text-sm font-medium tabular-nums">{runTime(run.runMs)}</span>
      </RunLink>
    </li>
  );
}
