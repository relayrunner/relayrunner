import { CheckIcon, MinusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RouterSetup } from "@/lib/router-setup";
import { plural } from "@/lib/job-times";
import { count, exact } from "@/lib/utils";

/** Rows shown before "Show all". */
const FIRST_ROWS = 6;

/**
 * Which of the workspace's workflows go through a relay, from their runs in the last `days` days.
 * Not routed ones come first, since those are left to set up. Nothing until there's a run.
 */
export function RouterWorkflows({ setup }: { setup: RouterSetup | null }) {
  const [all, setAll] = useState(false);
  if (!setup || setup.workflows.length === 0) return null;
  const { workflows, days } = setup;
  const routed = workflows.filter((w) => w.routedRuns > 0).length;
  const shown = all ? workflows : workflows.slice(0, FIRST_ROWS);
  return (
    <section aria-label="Workflows" className="grid gap-3 rounded-xl border px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">Workflows</h2>
        <p className="text-xs text-muted-foreground">
          {routed} of {workflows.length} routed · last {days} days
        </p>
      </div>
      <ul className="grid gap-1.5 text-sm">
        {shown.map((w) => (
          <li key={`${w.repositoryId}:${w.workflow}`} className="flex min-w-0 items-center gap-2.5">
            {w.routedRuns > 0 ? (
              <CheckIcon aria-label="Routed" className="size-4 shrink-0 text-go" />
            ) : (
              <MinusIcon
                aria-label="Not routed"
                className="size-4 shrink-0 text-muted-foreground"
              />
            )}
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">{w.repository} · </span>
              {w.workflow}
            </span>
            <span
              className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
              title={`${exact(w.routedRuns)} of ${exact(w.runs)} runs`}
            >
              {w.routedRuns === 0
                ? "Not routed"
                : w.routedRuns === w.runs
                  ? plural(w.runs, "run")
                  : `${count(w.routedRuns)} of ${count(w.runs)} runs`}
            </span>
          </li>
        ))}
      </ul>
      {workflows.length > FIRST_ROWS && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${workflows.length}`}
        </Button>
      )}
    </section>
  );
}
