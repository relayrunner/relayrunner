// The Router page's week of routing: how many runs took the first step that fits them, how many
// the Router sent further down the order and why, and a bar a day.
import { useEffect, useState } from "react";
import { Count } from "@/components/count";
import { type Series, StackedBars, Swatch } from "@/components/stacked-bars";
import { authDisabled } from "@/lib/auth-client";
import {
  getRouteOutcomes,
  type MoveReason,
  type OutcomeCounts,
  OUTCOME_DAYS,
  type RouteOutcomes,
  sampleRouteOutcomes,
} from "@/lib/route-outcomes";
import { count, percent } from "@/lib/utils";

const SERIES: Series[] = [
  { key: "first", label: "First choice", color: "var(--rr-idle)" },
  { key: "movedOn", label: "Moved down the order", color: "var(--rr-go)" },
  { key: "waited", label: "Waited for a machine", color: "var(--rr-run)" },
  { key: "failed", label: "Nowhere to go", color: "var(--rr-del)" },
];

type Outcome = keyof OutcomeCounts;

const REASONS: Record<MoveReason, string> = {
  machines: "machines busy or offline",
  limit: "minutes or spending limit",
  unhealthy: "runner not picking up jobs",
};

export function RouteOutcomesCard({ workspaceId }: { workspaceId: string }) {
  const [outcomes, setOutcomes] = useState<RouteOutcomes | null>(null);
  useEffect(() => {
    if (authDisabled) {
      setOutcomes(sampleRouteOutcomes());
      return;
    }
    let live = true;
    getRouteOutcomes(workspaceId).then(
      (result) => live && setOutcomes(result),
      // The page works without it.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  // Nothing routed yet: the setup card says how to start.
  if (!outcomes || outcomes.runs === 0) return null;
  const { runs, reasons } = outcomes;
  const series = SERIES.filter((s) => s.key === "first" || outcomes[s.key as Outcome] > 0);
  // Under the first choice its share, under moved on why, one reason a line.
  const details: Partial<Record<Outcome, string[]>> = {
    first: [`${percent(outcomes.first / runs)} of ${count(runs)} routed runs`],
    movedOn: reasons.map((r) => `${r.count.toLocaleString()} ${REASONS[r.reason]}`),
  };

  return (
    <section className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Past {OUTCOME_DAYS} days</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
        {series.map((s) => (
          <div key={s.key} className="grid content-start gap-0.5">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Swatch color={s.color} />
              {s.label}
            </dt>
            <dd className="text-xl font-semibold tabular-nums">
              <Count value={outcomes[s.key as Outcome]} />
            </dd>
            {details[s.key as Outcome]?.map((line) => (
              <dd key={line} className="text-xs text-muted-foreground">
                {line}
              </dd>
            ))}
          </div>
        ))}
      </dl>
      <StackedBars
        buckets={outcomes.buckets.map(({ start, ...counts }) => ({ start, values: counts }))}
        bucketMs={outcomes.bucketMs}
        series={series}
        format={(n) => n.toLocaleString()}
        label={`Routed runs on each of the past ${OUTCOME_DAYS} days, by how they were routed`}
        height={130}
      />
    </section>
  );
}
