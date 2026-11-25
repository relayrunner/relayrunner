// Every successful run of one workflow over the window, for its page: a faint dot per run in the
// order they finished, so quiet days take no room, a line through the median of each runner's
// nearby runs, and evaluation runs as rings. Shows the whole workflow or one job, as time, cost per
// run or wait.
import { useMemo } from "react";
import { OrderAxis, useWidth } from "@/components/chart-parts";
import { rollingSpreads } from "@/lib/chart-trend";
import { clock, niceStep, type WorkflowRunPoint } from "@/lib/job-times";
import { shortDate } from "@/lib/time-zone";

export type ChartSeries = { key: string; name: string; color: string };
export type ChartMetric = "time" | "cost" | "wait";

const HEIGHT = 300;
const TOP = 12;
const BOTTOM = 26;
const RIGHT = 12;

/**
 * A point's value for the series: the run, or its one job on that runner. A whole run's wait is
 * its longest-waiting job's.
 */
export function pointsOf(
  runs: WorkflowRunPoint[],
  key: string,
  job: string | null,
  metric: ChartMetric,
): { at: number; value: number; evaluation: boolean; runId: number }[] {
  return runs.flatMap((run) => {
    let ms: number;
    let usd: number | null;
    let waitMs: number | null;
    if (job === null) {
      if (run.environment !== key) return [];
      ({ ms, usd } = run);
      const waits = run.jobs.flatMap((each) => (each.waitMs === null ? [] : [each.waitMs]));
      waitMs = waits.length ? Math.max(...waits) : null;
    } else {
      const found = run.jobs.find((each) => each.name === job && each.environment === key);
      if (!found) return [];
      ({ ms, usd, waitMs } = found);
    }
    const value = metric === "cost" ? usd : metric === "wait" ? waitMs : ms;
    return value === null
      ? []
      : [{ at: run.at, value, evaluation: run.evaluation, runId: run.runId }];
  });
}

function costStep(max: number) {
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
  return steps.find((step) => step >= max / 4) ?? 10;
}

const costText = (usd: number) => (usd === 0 ? "$0" : `$${usd.toFixed(usd < 0.01 ? 3 : 2)}`);

export function WorkflowRunsChart({
  runs,
  series,
  job,
  metric,
}: {
  runs: WorkflowRunPoint[];
  series: ChartSeries[];
  /** One job's name, or null for the whole workflow. */
  job: string | null;
  metric: ChartMetric;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const cost = metric === "cost";
  // Every runner's points share one order, so runs side by side finished at about the same time.
  const { lines, times } = useMemo(() => {
    const all = series.flatMap((each) =>
      pointsOf(runs, each.key, job, metric).map((point) => ({ ...point, line: each.key })),
    );
    all.sort((a, b) => a.at - b.at);
    const placed = all.map((point, index) => ({ ...point, index }));
    return {
      times: all.map((point) => point.at),
      lines: series.map((each) => {
        const points = placed.filter((point) => point.line === each.key);
        const routed = points.filter((point) => !point.evaluation);
        const medians = rollingSpreads(routed.map((point) => point.value));
        return {
          ...each,
          points,
          trend: routed.map((point, at) => ({ index: point.index, value: medians[at]!.median })),
        };
      }),
    };
  }, [runs, series, job, metric]);
  const values = lines.flatMap((line) => line.points.map((point) => point.value));
  const max = Math.max(...values, cost ? 0.01 : metric === "wait" ? 10_000 : 60_000) * 1.08;
  const step = cost ? costStep(max) : niceStep(max / 4);
  const yMax = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const format = cost ? costText : clock;
  const left = cost ? 52 : 44;
  const slot = Math.max(width - left - RIGHT, 1) / Math.max(times.length, 1);
  const x = (index: number) => left + (index + 0.5) * slot;
  const y = (value: number) => TOP + (1 - value / yMax) * (HEIGHT - TOP - BOTTOM);

  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${cost ? "Cost" : metric === "wait" ? "Wait" : "Time"} of each successful run in order, by runner`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={left} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} stroke="var(--border)" />
              <text
                x={left - 8}
                y={y(tick) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {format(tick)}
              </text>
            </g>
          ))}
          <OrderAxis
            times={times}
            left={left}
            slot={slot}
            maxX={width - RIGHT - 32}
            top={TOP}
            bottom={HEIGHT - BOTTOM}
          />
          {lines.map((line) => (
            <g key={line.key}>
              {line.points.map((point) =>
                point.evaluation ? null : (
                  <circle
                    key={`${point.runId}-${point.at}`}
                    cx={x(point.index)}
                    cy={y(point.value)}
                    r={2.5}
                    fill={line.color}
                    fillOpacity={0.3}
                  >
                    <title>{`${line.name} · ${format(point.value)} · ${shortDate(point.at)}`}</title>
                  </circle>
                ),
              )}
              {line.trend.length > 1 && (
                <polyline
                  points={line.trend
                    .map((point) => `${x(point.index)},${y(point.value)}`)
                    .join(" ")}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              )}
              {line.points.map((point) =>
                point.evaluation ? (
                  <circle
                    key={`e${point.runId}-${point.at}`}
                    cx={x(point.index)}
                    cy={y(point.value)}
                    r={4.5}
                    fill="var(--card)"
                    stroke={line.color}
                    strokeWidth={2}
                  >
                    <title>{`${line.name} evaluation · ${format(point.value)}`}</title>
                  </circle>
                ) : null,
              )}
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
