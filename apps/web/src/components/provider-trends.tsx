// A provider page's charts over time: each busy runner type's queue wait or job time at the chosen
// percentile, or the share of its jobs the runner gave up on before a step ran.
import { useEffect, useState } from "react";
import { type Line, LineChart } from "@/components/line-chart";
import { runnerName } from "@/components/providers";
import { OptionPicker } from "@/components/range-picker";
import { Legend, seriesColor } from "@/components/stacked-bars";
import { clock } from "@/lib/job-times";
import {
  getProviderTrends,
  type Percentile,
  PERCENTILE_OPTIONS,
  type ProviderTrends,
  TREND_METRICS,
  type TrendMetric,
} from "@/lib/provider-trends";
import { type TimeRange } from "@/lib/time-range";

const NOTES: Record<TrendMetric, string> = {
  wait: "From queued until a runner started the job.",
  run: "From start to finish, for jobs that passed.",
  failures: "Share of jobs that failed before any step ran, such as a runner that never came up.",
};

// Round steps for an axis of times: seconds, then minutes (never hours).
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map(
  (s) => s * 1000,
);
const timeStep = (max: number) => TIME_STEPS.find((s) => s * 4 >= max) ?? Math.ceil(max / 4);
const timeAxis = (ms: number) => (ms < 60_000 ? `${ms / 1000}s` : `${Math.round(ms / 60_000)}m`);
// Fewer jobs than this in a bar give no failure rate, so one failure in two jobs isn't 50%.
const RATE_JOBS = 10;
const shareStep = (max: number) => [1, 2, 5, 10, 20, 25, 50].find((s) => s * 4 >= max) ?? 25;

export function ProviderTrendsCard({
  provider,
  range,
  metric,
  percentile,
  onMetric,
  onPercentile,
}: {
  provider: string;
  range: TimeRange;
  metric: TrendMetric;
  percentile: Percentile;
  onMetric: (metric: TrendMetric) => void;
  onPercentile: (percentile: Percentile) => void;
}) {
  const [trends, setTrends] = useState<ProviderTrends | null>(null);
  useEffect(() => {
    let live = true;
    getProviderTrends(provider, range).then(
      (result) => live && setTrends(result),
      // The page works without it.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [provider, range]);

  const runners = trends?.runners ?? [];
  const starts = runners[0]?.points.map((p) => p.start) ?? [];
  // One point says nothing the tiles don't.
  if (!trends || starts.length < 2) return null;

  // Colours follow the runner types, so a quiet one dropping out doesn't recolour the rest.
  const lines: Line[] = runners
    .map((runner, i) => ({
      key: runner.key,
      label: runnerName(provider, runner.label),
      color: seriesColor(i),
      values: runner.points.map((point) => {
        if (metric === "failures")
          return point.jobs >= RATE_JOBS ? (point.runnerFailures / point.jobs) * 100 : null;
        return point[metric]?.[`p${percentile}`] ?? null;
      }),
    }))
    .filter((line) => line.values.some((value) => value !== null));
  const failures = metric === "failures";
  const title = TREND_METRICS.find((m) => m.value === metric)!.label;

  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {title}
            {!failures && ` at P${percentile}`},{" "}
            {trends.bucketMs > 86_400_000 ? "by week" : "by day"}
          </h3>
          <p className="text-sm text-muted-foreground">{NOTES[metric]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OptionPicker label="Chart" options={TREND_METRICS} value={metric} onChange={onMetric} />
          {!failures && (
            <OptionPicker
              label="Percentile"
              options={PERCENTILE_OPTIONS}
              value={percentile}
              onChange={onPercentile}
            />
          )}
        </div>
      </div>
      <LineChart
        starts={starts}
        bucketMs={trends.bucketMs}
        lines={lines}
        step={failures ? shareStep : timeStep}
        ceiling={failures ? 100 : undefined}
        axis={failures ? (v) => `${v}%` : timeAxis}
        format={failures ? (v) => `${v.toFixed(v < 10 ? 1 : 0)}%` : clock}
        label={`${title} by runner type`}
      />
      <Legend series={lines} />
    </section>
  );
}
