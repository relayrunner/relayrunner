// One evaluation's page (`?id`): its header, the runs while they go, then the results.
import { SectionBoundary } from "@/components/error-boundary";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, ArrowUpRightIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { providerStyle, TILE } from "@/components/providers";
import { Button } from "@/components/ui/button";
import {
  ACTIVE_STATES,
  cancelEvaluation,
  editUrl,
  type EvaluationReport,
  EVALUATION_RUNS,
  getEvaluation,
  retryEvaluation,
} from "@/lib/evaluations";
import { providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";
import { EVALUATE_STEP, EvaluateStepper } from "@/components/evaluate-stepper";
import { RunMeta, Results } from "@/features/evaluations/results";
import { usePolled, workflowFile } from "@/features/evaluations/shared";

/**
 * The page's title. Before an evaluation runs it explains what one does; once it runs, the run's
 * repo, branch and runner label take that line, with the page's actions beside the title.
 */
export function EvaluateHeader({
  provider,
  report,
  actions,
}: {
  provider: string;
  report?: EvaluationReport;
  actions?: ReactNode;
}) {
  const { name } = providerInfo(provider);
  const { icon, tile } = providerStyle(provider);
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <span className={cn(TILE, "size-12 rounded-[10px] [&_svg]:scale-150", tile)}>{icon}</span>
        <div className="grid min-w-0 gap-1">
          <h1 className="text-2xl leading-tight font-bold tracking-[-0.01em]">Evaluate {name}</h1>
          {report ? (
            <RunMeta report={report} />
          ) : (
            <p className="text-muted-foreground">
              Run one of your workflows on {name} {EVALUATION_RUNS} times and compare it with how it
              runs today. Your Router isn't used or changed.
            </p>
          )}
        </div>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}

// ---- One evaluation ------------------------------------------------------------------------------

export function EvaluationView({
  id,
  provider,
  editable,
}: {
  id: string;
  provider: string;
  editable: boolean;
}) {
  const [refresh, setRefresh] = useState(0);
  const load = () => getEvaluation(id);
  const [polling, setPolling] = useState(true);
  const { value: report, error } = usePolled(load, polling, [id, refresh]);
  useEffect(() => {
    if (report && !ACTIVE_STATES.includes(report.state)) setPolling(false);
  }, [report]);
  if (!report)
    return (
      <>
        <EvaluateHeader provider={provider} />
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </>
    );
  const again = () => setRefresh((n) => n + 1);
  // Still waiting on a dispatch, the evaluation is part of setup; once it runs there's no going
  // back through the steps, so they give way to the run's details and what to do next.
  if (report.state === "waiting")
    return (
      <>
        <EvaluateHeader provider={provider} />
        <EvaluateStepper at={EVALUATE_STEP.choose} provider={provider} />
        <NoDispatch report={report} editable={editable} onChange={again} />
      </>
    );
  return (
    <>
      <EvaluateHeader provider={provider} report={report} actions={<NextSteps report={report} />} />
      <SectionBoundary>
        <Results report={report} editable={editable} onChange={again} />
      </SectionBoundary>
    </>
  );
}

/** What to do once an evaluation has finished or stopped: nothing while it runs. */
function NextSteps({ report }: { report: EvaluationReport }) {
  if (ACTIVE_STATES.includes(report.state)) return null;
  const { name } = providerInfo(report.provider);
  // Stopped before any run finished: nothing to add to the Router on.
  const empty =
    (report.state === "failed" || report.state === "cancelled") &&
    !report.attempts.some((a) => a.status === "done" && a.conclusion === "success");
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" asChild>
        <Link to="/providers/$provider/evaluate" params={{ provider: report.provider }}>
          <RotateCcwIcon />
          Evaluate another workflow
        </Link>
      </Button>
      {!empty && (
        <Button asChild>
          <Link to="/router">
            Add {name} to Router
            <ArrowRightIcon />
          </Link>
        </Button>
      )}
    </div>
  );
}

function NoDispatch({
  report,
  editable,
  onChange,
}: {
  report: EvaluationReport;
  editable: boolean;
  onChange: () => void;
}) {
  const title = report.workflow ?? workflowFile(report.workflowPath);
  const [busy, setBusy] = useState(false);
  const act = (call: () => Promise<unknown>) => async () => {
    setBusy(true);
    await call().catch(() => undefined);
    setBusy(false);
    onChange();
  };
  return (
    <div className="grid max-w-3xl gap-6">
      <RunMeta report={report} />
      <div className="grid gap-3 rounded-xl border border-run-edge bg-run/10 p-4 text-sm">
        <div className="flex items-start gap-2">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-run" />
          <div className="grid gap-1">
            <span className="font-medium">{title} can't be started on demand yet</span>
            <span className="text-muted-foreground">
              Add <code className="font-mono text-[13px]">workflow_dispatch</code> to its{" "}
              <code className="font-mono text-[13px]">on:</code> triggers on {report.ref}. Nothing
              else about the workflow changes. The runs start on their own after the next push to{" "}
              {report.ref} that runs it.
            </span>
          </div>
        </div>
        <CodeBlock
          code={`on:\n  workflow_dispatch:\n  # …the triggers it already has`}
          lang="yaml"
          className="rounded-lg"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <a
            href={editUrl(report.repository, report.ref, report.workflowPath)}
            target="_blank"
            rel="noreferrer"
          >
            Edit {workflowFile(report.workflowPath)} on GitHub
            <ArrowUpRightIcon className="size-3.5" />
          </a>
        </Button>
        {editable && (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={act(() => retryEvaluation(report.id))}
            >
              Try again now
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={act(() => cancelEvaluation(report.id))}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
