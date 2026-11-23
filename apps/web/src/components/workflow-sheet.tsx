import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { CommitBy } from "@/components/commit";
import { quantile } from "@/lib/chart-trend";
import { DurationChart, runPoints } from "@/components/duration-chart";
import { TimeRangePicker } from "@/components/range-picker";
import { Facts, LINK, Links, RunLink } from "@/components/run-sheet";
import { StatusIcon } from "@/components/status-icon";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { withWorkflow } from "@/components/workflow-link";
import { timeAgo } from "@/lib/activity";
import { clock } from "@/lib/job-times";
import { WORKFLOW_DEFAULT_RANGE, WORKFLOW_RANGES } from "@/lib/panels";
import {
  HISTORY_DEFAULT_RANGE,
  isFailure,
  getRuns,
  type Run,
  type RunsReport,
  runParam,
  triggerText,
} from "@/lib/runs";
import { unlessDefault, useSetSearch } from "@/lib/search-params";
import { rangePhrase, type TimeRange } from "@/lib/time-range";
import { cn, elapsed, percent } from "@/lib/utils";
import { type WorkflowRef, workflowParam } from "@/lib/workflow-ref";

const RECENT = 20;

// A workflow's runs over a range, kept for a minute so reopening one shows it at once; new runs
// keep arriving.
function useWorkflowRuns(workflow: WorkflowRef, range: TimeRange) {
  return useQuery({
    queryKey: ["workflow-runs", workflowParam(workflow), range],
    queryFn: async () => ({ range, report: await getRuns(range, workflow) }),
    staleTime: 60_000,
    // The last report stays up while another range loads.
    placeholderData: keepPreviousData,
  });
}

/**
 * One workflow's detail panel: how long its runs took and how often they passed over a range, and
 * its latest runs, each opening in History. Which workflow is open lives in the URL
 * (`?wf=`), so any page can open it and the back button steps out of it.
 */
export function WorkflowSheet({ workflow, range }: { workflow: WorkflowRef; range: TimeRange }) {
  const navigate = useNavigate();
  const close = () => void navigate({ to: ".", search: withWorkflow(), resetScroll: false });
  const setSearch = useSetSearch<{ wfRange?: TimeRange }>();
  const setRange = (next: TimeRange) =>
    setSearch({ wfRange: unlessDefault(next, WORKFLOW_DEFAULT_RANGE) });
  const { data: shown, isError: failed } = useWorkflowRuns(workflow, range);

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent aria-describedby={undefined} widthKey="workflow-panel-width">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-5 py-5 sm:px-6">
          <header className="grid gap-1 pr-8">
            <SheetTitle className="break-words">{workflow.workflow}</SheetTitle>
            <SheetDescription>{workflow.repository}</SheetDescription>
          </header>
          <TimeRangePicker {...WORKFLOW_RANGES} value={range} onChange={setRange} />
          {failed ? (
            <p className="text-sm text-muted-foreground">
              Couldn't load this workflow's runs. Try again in a moment.
            </p>
          ) : !shown ? (
            <Placeholder />
          ) : (
            <WorkflowView
              workflow={workflow}
              report={shown.report}
              reportRange={shown.range}
              loading={shown.range !== range}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function WorkflowView({
  workflow,
  report,
  reportRange,
  loading,
}: {
  workflow: WorkflowRef;
  /** The workflow's runs. */
  report: RunsReport;
  /** The range `report` is for, which lags the picker while another loads. */
  reportRange: TimeRange;
  loading: boolean;
}) {
  // Just this workflow's, newest first.
  const { runs } = report;
  const points = useMemo(() => runPoints(runs), [runs]);
  const finished = runs.filter(
    (run) => run.status === "completed" && run.conclusion !== "cancelled",
  );
  const failures = finished.filter((run) => isFailure(run.conclusion)).length;
  const passed = finished.filter((run) => run.conclusion === "success");
  const times = passed.flatMap((run) => (run.wallMs === null ? [] : [run.wallMs]));
  const median = times.length
    ? quantile(
        times.toSorted((a, b) => a - b),
        0.5,
      )
    : null;
  const historySearch = {
    repo: workflow.repository,
    chart: workflow.workflow,
    range: unlessDefault(reportRange, HISTORY_DEFAULT_RANGE),
  };

  return (
    <div className={cn("grid gap-6 transition-opacity", loading && "opacity-60")}>
      {runs.length === 0 ? (
        <p className="rounded-lg border px-4 py-6 text-sm text-muted-foreground">
          No runs of this workflow in {rangePhrase(reportRange)}.
        </p>
      ) : (
        <>
          <Facts
            className="sm:grid-cols-4"
            items={[
              ["Runs", String(runs.length)],
              ["Success", finished.length ? percent(passed.length / finished.length) : "—"],
              ["Median run", clock(median)],
              ["Failed", String(failures)],
            ]}
          />
          {points.length > 0 && (
            <DurationChart
              points={points}
              range={reportRange}
              noun="run"
              group={undefined}
              onGroup={() => undefined}
              groupLabel="Workflow"
            />
          )}
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Recent runs</h3>
            <ul className="divide-y overflow-hidden rounded-lg border">
              {runs.slice(0, RECENT).map((run) => (
                <RunItem key={runParam(run)} run={run} />
              ))}
            </ul>
          </section>
        </>
      )}
      <Links>
        <Link to="/history" search={historySearch} className={LINK}>
          All runs in History <ChevronRightIcon aria-hidden className="size-3.5" />
        </Link>
      </Links>
    </div>
  );
}

function RunItem({ run }: { run: Run }) {
  const running = run.status !== "completed";
  return (
    <li>
      <RunLink
        run={run}
        className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 hover:bg-secondary/30"
      >
        <StatusIcon status={run.status} conclusion={run.conclusion} className="mt-0.5 size-4" />
        <span className="min-w-0">
          <span className="block truncate text-sm underline-offset-4 group-hover:underline">
            {run.title ?? run.workflow ?? `Run ${run.runId}`}
          </span>
          <span className="flex flex-wrap items-center gap-x-2.5 text-xs text-muted-foreground">
            <span>{[triggerText(run), run.branch].filter(Boolean).join(" on ")}</span>
            <CommitBy actor={run.actor} sha={run.sha} />
            {run.startedAt !== null && <span>{timeAgo(run.startedAt)}</span>}
          </span>
        </span>
        <span
          className={cn("text-sm tabular-nums", running ? "text-muted-foreground" : "font-medium")}
        >
          {running ? "Running" : elapsed(run.wallMs)}
        </span>
      </RunLink>
    </li>
  );
}

function Placeholder() {
  return (
    <div aria-busy aria-label="Loading workflow" className="grid gap-6">
      <div className="h-14 rounded-lg border" />
      <div className="h-40 rounded-lg bg-secondary/40" />
      <div className="grid rounded-lg border">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-12 items-center gap-4 px-3">
            <span className="h-3 w-48 max-w-[60%] rounded-sm bg-secondary" />
          </div>
        ))}
      </div>
    </div>
  );
}
