// Where time goes inside jobs, from the steps GitHub reports: a phase bar and legend, the Job types
// tab's split by type, and the steps of a job's average run for its detail on Performance.
import { useState } from "react";
import { Count } from "@/components/count";
import {
  overhead,
  PHASE_ORDER,
  phasesOf,
  type Phase,
  phaseColor,
  phaseLabel,
  type PhaseTimes,
  phaseTotal,
} from "@/lib/job-phases";
import { clock, minutesText, plural, type RunStep } from "@/lib/job-times";
import { typeLabel, type TypeSummary } from "@/lib/job-types";
import { cn, percent } from "@/lib/utils";

function PhaseSwatch({ phase, className }: { phase: Phase; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)}
      style={{ background: phaseColor(phase) }}
    />
  );
}

/** One bar split by phase, in stack order. */
export function PhaseBar({ phases, className }: { phases: PhaseTimes; className?: string }) {
  const total = phaseTotal(phases);
  if (!total) return null;
  return (
    <div
      className={cn("flex h-3 gap-0.5", className)}
      role="img"
      aria-label={PHASE_ORDER.flatMap((phase) =>
        phases[phase] ? [`${phaseLabel(phase)} ${percent(phases[phase] / total)}`] : [],
      ).join(", ")}
    >
      {PHASE_ORDER.map((phase) => {
        const ms = phases[phase];
        if (!ms) return null;
        return (
          <span
            key={phase}
            title={`${phaseLabel(phase)}: ${percent(ms / total)}`}
            className="h-full min-w-0.5 first:rounded-l last:rounded-r"
            style={{ width: `${(ms / total) * 100}%`, background: phaseColor(phase) }}
          />
        );
      })}
    </div>
  );
}

/** Each phase with its time, formatted by `format`. */
function PhaseLegend({
  phases,
  format,
}: {
  phases: PhaseTimes;
  format: (ms: number, total: number) => string;
}) {
  const total = phaseTotal(phases);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {PHASE_ORDER.map((phase) =>
        phases[phase] ? (
          <span key={phase} className="inline-flex items-center gap-1.5">
            <PhaseSwatch phase={phase} />
            {phaseLabel(phase)}
            <span className="font-medium text-foreground tabular-nums">
              {format(phases[phase], total)}
            </span>
          </span>
        ) : null,
      )}
    </div>
  );
}

/** The Job types tab's split of step time by phase, for all jobs and each type. */
export function TypePhases({ summary }: { summary: TypeSummary }) {
  const rows = [
    { key: "all", label: "All jobs", phases: summary.phases },
    ...summary.types.flatMap((type) =>
      type.stepped ? [{ key: type.key, label: typeLabel(type.key), phases: type.phases }] : [],
    ),
  ];
  const [picked, setPicked] = useState("all");
  const shown = rows.find((row) => row.key === picked) ?? rows[0]!;

  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Inside the jobs</h2>
      <p className="max-w-[62ch] text-sm text-muted-foreground">
        Each step sorted by its name. Overhead is every step besides the job's own work.
      </p>
      {summary.stepped === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          GitHub sends step times when a job finishes, so they show up as new jobs run.
        </p>
      ) : (
        <>
          <ul className="mt-4 grid gap-1">
            {rows.map((row) => {
              const share = overhead(row.phases);
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    aria-pressed={row.key === shown.key}
                    onClick={() => setPicked(row.key)}
                    className={cn(
                      "grid w-full gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60",
                      row.key === shown.key && "bg-muted",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={cn(row.key === "all" && "font-medium")}>{row.label}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {share === null ? "–" : `${percent(share)} overhead`}
                      </span>
                    </span>
                    <PhaseBar phases={row.phases} />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 grid gap-1.5 px-2">
            <p className="text-xs font-medium">{shown.label}, in minutes</p>
            <PhaseLegend phases={shown.phases} format={minutesText} />
          </div>
          {summary.stepped < summary.runs && (
            <p className="mt-3 px-2 text-xs text-muted-foreground">
              From <Count value={summary.stepped} /> of <Count value={summary.runs} /> jobs. GitHub
              didn't send steps for the rest.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// Steps shorter than this are folded into a count, so the list shows where time goes.
const QUICK_MS = 1_000;

/** A job's average successful run, step by step, for its detail on Performance. */
export function RunSteps({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) return null;
  const phases = phasesOf(steps);
  const shown = steps.filter((step) => step.ms >= QUICK_MS);
  const quick = steps.length - shown.length;
  const longest = Math.max(...shown.map((step) => step.ms), 1);

  return (
    <section className="grid min-w-0 gap-3 border-t pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Inside an average run</h3>
        <span className="text-sm text-muted-foreground tabular-nums">
          {percent(overhead(phases) ?? 0)} overhead
        </span>
      </div>
      <PhaseBar phases={phases} />
      <PhaseLegend phases={phases} format={(ms, total) => percent(ms / total)} />
      <ol className="grid gap-1 text-sm">
        {shown.map((step) => (
          <li
            key={step.name}
            className="grid grid-cols-[auto_minmax(0,1fr)_3.5rem] items-center gap-x-2"
          >
            <PhaseSwatch phase={step.phase} />
            <span className="relative min-w-0">
              {/* How long it takes next to the longest step, behind its name. */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-sm bg-foreground/[0.07]"
                style={{ width: `${(step.ms / longest) * 100}%` }}
              />
              <span className="relative block truncate px-1.5 py-0.5" title={step.name}>
                {step.name}
              </span>
            </span>
            <span className="text-right text-muted-foreground tabular-nums">{clock(step.ms)}</span>
          </li>
        ))}
      </ol>
      {quick > 0 && (
        <p className="text-xs text-muted-foreground">And {plural(quick, "step")} under a second.</p>
      )}
    </section>
  );
}
