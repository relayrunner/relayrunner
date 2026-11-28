// The Router page's week of routing, as a small card in the rail beside the order: the share of
// jobs that took their first choice and a strip a day, each day's breakdown in a tooltip.
import { useEffect, useState } from "react";
import { ChartTip, TipHead, TipRow, useWidth } from "@/components/chart-parts";
import { Swatch } from "@/components/stacked-bars";
import {
  getRouteOutcomes,
  type OutcomeBucket,
  type OutcomeCounts,
  OUTCOME_DAYS,
  type RouteOutcomes,
} from "@/lib/route-outcomes";
import { zoneFormat } from "@/lib/time-zone";
import { DAY_MS, plural } from "@/lib/job-times";
import { cn, count, exact, percent } from "@/lib/utils";

type Outcome = keyof OutcomeCounts;

const SERIES: { key: Outcome; label: string; color: string }[] = [
  { key: "first", label: "First choice", color: "var(--rr-idle)" },
  { key: "movedOn", label: "Moved down the order", color: "var(--rr-go)" },
  { key: "waited", label: "Waited for a machine", color: "var(--rr-run)" },
  { key: "failed", label: "Nowhere to go", color: "var(--rr-del)" },
];

const DAY = zoneFormat({ weekday: "short", month: "short", day: "numeric" });
const WEEKDAY = zoneFormat({ weekday: "narrow" });
// The strip's height in px.
const STRIP = 48;

function useOutcomes(workspaceId: string) {
  const [outcomes, setOutcomes] = useState<RouteOutcomes | null>(null);
  useEffect(() => {
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
  return outcomes;
}

export function RouteOutcomesCard({
  workspaceId,
  className,
}: {
  workspaceId: string;
  className?: string;
}) {
  const outcomes = useOutcomes(workspaceId);

  // Nothing routed yet: the setup card says how to start.
  if (!outcomes || outcomes.runs === 0) return null;
  const series = SERIES.filter((s) => s.key === "first" || outcomes[s.key] > 0);

  return (
    <section
      aria-label={`Routing, past ${OUTCOME_DAYS} days`}
      className={cn(
        "grid content-start gap-2.5 rounded-lg border border-border/60 bg-card px-4 py-3.5",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Past {OUTCOME_DAYS} days</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {count(outcomes.runs)} jobs
        </span>
      </div>

      <p className="flex items-baseline gap-1.5">
        <span className="text-xl font-semibold tabular-nums">
          {percent(outcomes.first / outcomes.runs)}
        </span>
        <span className="text-xs text-muted-foreground">took their first choice</span>
      </p>

      <DayStrip buckets={outcomes.buckets} series={series} />
    </section>
  );
}

/**
 * A column a day, stacked by outcome; hover or tap one for its breakdown. Its own component, so it
 * measures its width once it's on the page.
 */
function DayStrip({ buckets, series }: { buckets: OutcomeBucket[]; series: typeof SERIES }) {
  // The day under the pointer, by index.
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  const totals = buckets.map((b) => series.reduce((n, s) => n + b[s.key], 0));
  const max = Math.max(...totals, 1);
  const day = hover === null ? undefined : buckets[hover];
  const slot = width / buckets.length;

  return (
    <div ref={ref} className="relative">
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`,
        }}
        onPointerLeave={(event) => event.pointerType !== "touch" && setHover(null)}
      >
        {buckets.map((bucket, i) => (
          <button
            key={bucket.start}
            type="button"
            aria-label={`${DAY.format(bucket.start + DAY_MS / 2)}: ${exact(totals[i] ?? 0)} jobs`}
            aria-pressed={hover === i}
            className="grid gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerEnter={() => setHover(i)}
            onClick={() => setHover((h) => (h === i ? null : i))}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <span className="flex flex-col-reverse gap-px" style={{ height: STRIP }}>
              {series.map((s) => {
                const value = bucket[s.key];
                if (!value) return null;
                return (
                  <span
                    key={s.key}
                    className={cn(
                      "rounded-[2px] transition-opacity",
                      hover !== null && hover !== i && "opacity-40",
                    )}
                    style={{
                      height: Math.max((value / max) * STRIP, 1.5),
                      background: s.color,
                    }}
                  />
                );
              })}
            </span>
            <span
              className={cn(
                "text-center text-[10px] leading-none text-muted-foreground",
                hover === i && "font-medium text-foreground",
              )}
            >
              {WEEKDAY.format(bucket.start + DAY_MS / 2)}
            </span>
          </button>
        ))}
      </div>
      {hover !== null && day && width > 0 && (
        <ChartTip x={(hover + 0.5) * slot} y={0} width={width}>
          <TipHead
            title={DAY.format(day.start + DAY_MS / 2)}
            aside={plural(totals[hover] ?? 0, "job")}
          />
          {series.map((s) => (
            <TipRow
              key={s.key}
              mark={<Swatch color={s.color} className="size-2" />}
              label={s.label}
              value={exact(day[s.key])}
            />
          ))}
        </ChartTip>
      )}
    </div>
  );
}
