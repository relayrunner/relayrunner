// A provider's evaluations from the last RECENT_DAYS days, so people can get back to the results while
// they're still deciding. Older ones drop off: by then the provider's real runs on Performance say
// more than five trial runs did.
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/activity";
import {
  ACTIVE_STATES,
  getRecentEvaluations,
  RECENT_DAYS,
  type RecentEvaluation,
} from "@/lib/evaluations";
import { plural } from "@/lib/job-times";
import { providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";
import { PublicRepoMark } from "@/components/public-repo";

/** "25m ago", "yesterday", "12 days ago". */
const ago = (at: number) => {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days < 1 ? timeAgo(at) : days === 1 ? "yesterday" : `${days} days ago`;
};

/** The provider's recent evaluations, or undefined until they load. A failed read shows none. */
export function useRecentEvaluations(provider: string) {
  const [list, setList] = useState<RecentEvaluation[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getRecentEvaluations(provider).then(
      (next) => live && setList(next),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [provider]);
  return list;
}

/** "31% faster", "8% slower", or null without both numbers. */
function change(now: number | null, then: number | null, more: string, less: string) {
  if (now === null || then === null || then === 0) return null;
  const pct = Math.round(((now - then) / then) * 100);
  if (pct === 0) return `same ${less === "cheaper" ? "cost" : "time"}`;
  return pct < 0 ? `${-pct}% ${less}` : `${pct}% ${more}`;
}

function outcome(e: RecentEvaluation) {
  const versus = [
    change(e.ms, e.baselineMs, "slower", "faster"),
    change(e.usd, e.baselineUsd, "more per run", "cheaper"),
  ].filter(Boolean);
  const result = versus.length ? versus.join(" · ") : null;
  if (ACTIVE_STATES.includes(e.state)) {
    if (e.state === "waiting") return "Waiting for a workflow_dispatch trigger";
    if (e.finished === 0) return `Run 1 of ${e.runs} going`;
    return `Run ${e.attempt} of ${e.runs} going · ${result ?? ""} so far`;
  }
  if (e.state === "failed") return `Failed on run ${e.attempt} of ${e.runs}`;
  if (e.state === "cancelled")
    return e.finished === 0
      ? "Stopped before a run finished"
      : `Stopped after ${e.finished} of ${e.runs} runs${result ? ` · ${result}` : ""}`;
  return result ?? `${e.runs} runs`;
}

function StateIcon({ state }: { state: RecentEvaluation["state"] }) {
  if (ACTIVE_STATES.includes(state))
    return <LoaderCircleIcon aria-label="Running" className="size-4 animate-spin text-run" />;
  if (state === "failed")
    return <TriangleAlertIcon aria-label="Failed" className="size-4 text-destructive" />;
  if (state === "cancelled")
    return <CircleSlashIcon aria-label="Stopped" className="size-4 text-muted-foreground" />;
  return <CheckIcon aria-label="Done" className="size-4 text-go" />;
}

export function RecentEvaluations({
  provider,
  evaluations,
  className,
}: {
  provider: string;
  evaluations: RecentEvaluation[];
  className?: string;
}) {
  const { name } = providerInfo(provider);
  // Only the latest shows until asked: older ones are usually earlier tries of the same thing.
  const [open, setOpen] = useState(false);
  if (evaluations.length === 0) return null;
  const more = evaluations.length - 1;
  const shown = open ? evaluations : evaluations.slice(0, 1);
  return (
    <div className={cn("grid gap-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-semibold">Recent evaluations</h2>
      </div>
      <ul className="overflow-hidden rounded-xl border bg-card">
        {shown.map((e) => {
          const title = e.workflow ?? e.workflowPath.split("/").pop();
          return (
            <li key={e.id} className="relative border-b last:border-0 hover:bg-raised">
              <div className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="mt-0.5 shrink-0">
                  <StateIcon state={e.state} />
                </span>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <Link
                      to="/providers/$provider/evaluate"
                      params={{ provider }}
                      search={{ id: e.id }}
                      className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring"
                    >
                      {title}
                    </Link>
                    <span className="truncate text-xs text-muted-foreground">
                      {e.repository}
                      <PublicRepoMark repository={e.repository} />
                    </span>
                  </div>
                  <p className="text-muted-foreground sm:truncate">{outcome(e)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {e.vcpus} vCPU · {ago(e.createdAt)}
                  </span>
                  {e.routedRuns > 0 && (
                    <Link
                      to="/performance/workflow"
                      search={{ repo: e.repositoryId, workflow: e.workflow ?? undefined }}
                      className="relative z-10 flex items-center gap-1 text-xs font-medium whitespace-nowrap text-foreground hover:underline hover:underline-offset-2"
                    >
                      {plural(e.routedRuns, "run")} in CI since
                      <ArrowRightIcon aria-hidden className="size-3" />
                    </Link>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {more > 0 && (
          <li className="bg-raised-2">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex w-full items-center gap-1 px-4 py-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              {open ? "Show only the latest" : `Show ${more} more`}
              <ChevronDownIcon aria-hidden className={cn("size-3.5", open && "rotate-180")} />
            </button>
          </li>
        )}
      </ul>
      <p className="text-xs text-muted-foreground">
        After {RECENT_DAYS} days an evaluation drops off this list. By then{" "}
        <Link to="/performance" className="underline underline-offset-2 hover:text-foreground">
          Performance
        </Link>{" "}
        shows how {name} does on your real runs.
      </p>
    </div>
  );
}
