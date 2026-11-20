import { ChartColumnStackedIcon, ChartLineIcon } from "lucide-react";
import { Count } from "@/components/count";
import { memo, type ReactNode, useMemo, useState } from "react";
import { ChartTip, TipRow, topRounded, useWidth } from "@/components/chart-parts";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeAgo } from "@/lib/activity";
import {
  bucketIndex,
  bucketMsFor,
  chartStart,
  groupsByCount,
  type Spread,
  spreads,
} from "@/lib/chart-trend";
import { DAY_MS, HOUR_MS, niceStep, plural } from "@/lib/job-times";
import { type HistoryJob, isFailure, type JobUsage, type Run } from "@/lib/runs";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { formatMemory } from "@/lib/device";
import { startOfDay, startOfHours, zoneFormat } from "@/lib/time-zone";
import { cn, count, elapsed, percent } from "@/lib/utils";

type Result = "success" | "failed" | "cancelled";
/** How many runs or jobs ended each way from `at`, in one bar or less. */
export type Tally = { at: number } & Record<Result, number>;

/** One finished run or job on the chart. */
export type ChartPoint = {
  key: string;
  /** When it finished. */
  at: number;
  ms: number;
  result: Result;
  name: string;
  /** The workflow or job it's charted with: one group shows at a time. */
  group: string;
  usage?: JobUsage;
};

// `z` is the drawing order: failures last, so they sit on top where dots crowd.
const RESULT: Record<Result, { label: string; color: string; z: number }> = {
  success: { label: "Succeeded", color: "var(--rr-go)", z: 1 },
  failed: { label: "Failed", color: "var(--rr-del)", z: 2 },
  cancelled: { label: "Cancelled", color: "var(--rr-mute)", z: 0 },
};
/** Legend order, and bottom to top in a stacked bar. */
const RESULTS: Result[] = ["success", "failed", "cancelled"];
const resultOf = (conclusion: string | null): Result =>
  conclusion === "success" ? "success" : isFailure(conclusion) ? "failed" : "cancelled";

type Metric = "duration" | "cpu" | "memory";
/** What the dots can show: how long each took, or the CPU or memory it used (p95). */
const METRIC: Record<
  Metric,
  {
    label: string;
    value: (point: ChartPoint) => number;
    scale: (max: number) => ReturnType<typeof yScale>;
    tickText: (value: number) => string;
    valueText: (value: number) => string;
    tipText: (point: ChartPoint) => string;
  }
> = {
  duration: {
    label: "Duration",
    value: (point) => point.ms,
    scale: (max) => yScale(Math.max(max, 1000), niceStep(Math.max(max, 1000) / 3)),
    tickText: axisTime,
    valueText: elapsed,
    tipText: (point) => elapsed(point.ms),
  },
  cpu: {
    label: "P95 CPU",
    // Only points with usage are given CPU or memory.
    value: (point) => point.usage?.cpuP95 ?? 0,
    scale: () => yScale(1, 0.25, true),
    tickText: percent,
    valueText: percent,
    tipText: ({ usage }) => `${percent(usage!.cpuP95)} of ${plural(usage!.cpus, "vCPU")}`,
  },
  memory: {
    label: "P95 memory",
    value: (point) => point.usage?.memoryP95Mb ?? 0,
    scale: (max) => yScale(Math.max(max, 256), memoryStep(Math.max(max, 256))),
    tickText: (mb) => (mb ? formatMemory(mb) : "0"),
    valueText: formatMemory,
    tipText: ({ usage }) =>
      `${formatMemory(usage!.memoryP95Mb)} of ${formatMemory(usage!.memoryMb)}`,
  },
};
const METRICS: Metric[] = ["duration", "cpu", "memory"];

const HEIGHT = 168;
const PAD = { top: 8, right: 8, bottom: 22, left: 40 };
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;
const BARS_FLAG = "rr:history-chart-bars";

/**
 * How long one workflow's (or job's) runs took over the page's range: the median of each bucket
 * as a line, the middle 80% shaded around it, and each failure marked on top. Cancelled runs are
 * hidden until their legend entry is pressed. Or how many finished per bucket, by result.
 */
export const DurationChart = memo(function DurationChart({
  points: all,
  days,
  noun,
  group,
  onGroup,
  groupLabel,
}: {
  points: ChartPoint[];
  days: number;
  /** "run" or "job". */
  noun: string;
  /** The group shown, from the URL. Left out, the busiest. */
  group: string | undefined;
  /** Gets undefined when the busiest is picked, so the URL leaves it out. */
  onGroup: (group: string | undefined) => void;
  /** What a group is, such as "Workflow". */
  groupLabel: string;
}) {
  const [bars, setBars] = useState(() => readFlag(BARS_FLAG));
  const [picked, setMetric] = useState<Metric>("duration");
  const [showCancelled, setShowCancelled] = useState(false);
  const groups = useMemo(() => groupsByCount(all.map((point) => point.group)), [all]);
  const shown = group !== undefined && groups.includes(group) ? group : groups[0];
  const points = useMemo(() => all.filter((point) => point.group === shown), [all, shown]);
  const sampled = useMemo(() => points.filter((point) => point.usage), [points]);
  // CPU and memory only when some of what's shown reported them.
  const metric = sampled.length > 0 ? picked : "duration";
  const firstAt = useMemo(
    () =>
      points.reduce<number | undefined>(
        (min, { at }) => (min === undefined || at < min ? at : min),
        undefined,
      ),
    [points],
  );
  const [ref, frame, bucketMs] = useFrame(days, { firstAt });
  const counts = useMemo(() => {
    const totals: Record<Result, number> = { success: 0, failed: 0, cancelled: 0 };
    for (const point of points) totals[point.result]++;
    return totals;
  }, [points]);
  // Only the bar view needs them.
  const tallies = useMemo(
    () =>
      bars
        ? points.map((point) => ({
            at: point.at,
            success: 0,
            failed: 0,
            cancelled: 0,
            [point.result]: 1,
          }))
        : [],
    [points, bars],
  );

  function choose(next: boolean) {
    setBars(next);
    saveFlag(BARS_FLAG, next);
  }
  const per = perBar(bucketMs);
  const name = groups.length > 1 ? `${shown} ${noun}s` : `${noun}s`;

  return (
    <div className="grid gap-3 rounded-xl border bg-card px-4 pt-3 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!bars && sampled.length > 0 ? (
          <div role="group" aria-label="Measure" className="flex gap-1">
            {METRICS.map((value) => (
              <Button
                key={value}
                size="xs"
                variant={metric === value ? "secondary" : "ghost"}
                aria-pressed={metric === value}
                onClick={() => setMetric(value)}
              >
                {METRIC[value].label}
              </Button>
            ))}
          </div>
        ) : (
          <h2 className="text-sm font-medium first-letter:uppercase">
            {bars ? `${noun}s per ${per}` : `How long ${noun}s took`}
          </h2>
        )}
        <div className="flex min-w-0 items-center gap-2">
          {groups.length > 1 && (
            <Select
              value={shown}
              onValueChange={(next) => onGroup(next === groups[0] ? undefined : next)}
            >
              <SelectTrigger size="sm" aria-label={groupLabel} className="h-7 min-w-0 max-w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {groups.map((each) => (
                  <SelectItem key={each} value={each}>
                    {each}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div role="group" aria-label="Chart" className="flex gap-1">
            <ChartToggle label="Duration" pressed={!bars} onClick={() => choose(false)}>
              <ChartLineIcon />
            </ChartToggle>
            <ChartToggle label="Count" pressed={bars} onClick={() => choose(true)}>
              <ChartColumnStackedIcon />
            </ChartToggle>
          </div>
        </div>
      </div>
      <div ref={ref} className="relative" style={{ height: HEIGHT }}>
        {points.length === 0 ? (
          <p className="grid h-full place-items-center text-sm text-muted-foreground">
            No finished {noun}s in this range.
          </p>
        ) : frame.width === 0 ? null : bars ? (
          <Bars
            tallies={tallies}
            frame={frame}
            bucketMs={bucketMs}
            label={`${plural(points.length, noun)} per ${per}, by result`}
          />
        ) : (
          <Trend
            points={metric === "duration" ? points : sampled}
            metric={metric}
            showCancelled={showCancelled}
            frame={frame}
            bucketMs={bucketMs}
            label={`${METRIC[metric].label} of ${name} per ${per}: the median, the middle 80%, and each failure`}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <ResultLegend
          counts={counts}
          trend={!bars}
          showCancelled={showCancelled}
          onCancelled={() => setShowCancelled(!showCancelled)}
        />
        {!bars &&
          (metric === "duration" ? (
            <p>Median per {per}, with the middle 80% shaded</p>
          ) : (
            <p>
              {count(sampled.length)} of {plural(points.length, noun)}, from connected machines
            </p>
          ))}
      </div>
    </div>
  );
});

/**
 * How many runs or jobs finished per bar over the range, each bar stacked by result, from counts
 * made elsewhere, such as Admin › Jobs. Bars are `bucketMs` wide, or History's width for the range.
 */
export const CountChart = memo(function CountChart({
  tallies,
  days,
  noun,
  bucketMs: wanted,
}: {
  tallies: Tally[];
  days: number;
  noun: string;
  bucketMs?: number;
}) {
  const [ref, frame, bucketMs] = useFrame(days, { bucketMs: wanted });
  const counts = useMemo(() => {
    const totals: Record<Result, number> = { success: 0, failed: 0, cancelled: 0 };
    for (const tally of tallies) for (const result of RESULTS) totals[result] += tally[result];
    return totals;
  }, [tallies]);
  const total = counts.success + counts.failed + counts.cancelled;
  const per = perBar(bucketMs);

  return (
    <div className="grid gap-3 rounded-xl border bg-card px-4 pt-3 pb-4">
      <h2 className="text-sm font-medium first-letter:uppercase">{`${noun}s per ${per}`}</h2>
      <div ref={ref} className="relative" style={{ height: HEIGHT }}>
        {total === 0 ? (
          <p className="grid h-full place-items-center text-sm text-muted-foreground">
            No finished {noun}s in this range.
          </p>
        ) : frame.width === 0 ? null : (
          <Bars
            tallies={tallies}
            frame={frame}
            bucketMs={bucketMs}
            label={`${plural(total, noun)} per ${per}, by result`}
          />
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        <ResultLegend counts={counts} />
      </div>
    </div>
  );
});

/**
 * Each result's mark, name and count. Under a trend, succeeded shows as the line and its band, and
 * cancelled is a switch that shows or hides those runs.
 */
function ResultLegend({
  counts,
  trend,
  showCancelled,
  onCancelled,
}: {
  counts: Record<Result, number>;
  trend?: boolean;
  showCancelled?: boolean;
  onCancelled?: () => void;
}) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1">
      {RESULTS.map((result) => {
        const entry = (
          <>
            {trend && result === "success" ? <TrendMark /> : <ResultMark result={result} />}
            {RESULT[result].label}
            <span className="font-medium text-foreground tabular-nums">
              <Count value={counts[result]} />
            </span>
          </>
        );
        return (
          <li key={result} className="inline-flex items-center gap-1.5">
            {trend && result === "cancelled" ? (
              <button
                type="button"
                aria-pressed={showCancelled}
                title={showCancelled ? "Hide cancelled" : "Show cancelled"}
                onClick={onCancelled}
                className={cn(
                  "-mx-1 inline-flex items-center gap-1.5 rounded px-1 hover:text-foreground",
                  !showCancelled && "opacity-60 [&_span]:text-muted-foreground",
                )}
              >
                {entry}
              </button>
            ) : (
              entry
            )}
          </li>
        );
      })}
    </ul>
  );
}

const perBar = (bucketMs: number) =>
  bucketMs === HOUR_MS ? "hour" : bucketMs === DAY_MS ? "day" : `${bucketMs / HOUR_MS} hours`;

/**
 * The plot's measured width and time range, in whole buckets so the first and last are full width.
 * With `firstAt`, it starts there instead of at the start of the range, and buckets fit that span.
 */
function useFrame(
  days: number,
  { firstAt, bucketMs: wanted }: { firstAt?: number; bucketMs?: number },
) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const now = Date.now();
  const from = chartStart(now, days, firstAt);
  const bucketMs = wanted ?? bucketMsFor(now - from);
  const end = floorTo(now, bucketMs) + bucketMs;
  const start = floorTo(from, bucketMs);
  const frame = useMemo(() => ({ start, end, width }), [start, end, width]);
  return [ref, frame, bucketMs] as const;
}

function ChartToggle({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant={pressed ? "secondary" : "ghost"}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="size-7"
    >
      {children}
    </Button>
  );
}

/** The legend's mark for a result: the same shape the dots use, so color isn't the only cue. */
function ResultMark({ result }: { result: Result }) {
  return (
    <svg aria-hidden viewBox="-5 -5 10 10" className="size-2.5">
      <Mark result={result} x={0} y={0} />
    </svg>
  );
}

// Succeeded is a dot, failed a diamond, cancelled a ring.
function Mark({ result, x, y, big }: { result: Result; x: number; y: number; big?: boolean }) {
  const { color } = RESULT[result];
  const r = big ? 5 : 3.5;
  if (result === "failed") {
    const d = r * 1.25;
    return <path d={`M${x} ${y - d}L${x + d} ${y}L${x} ${y + d}L${x - d} ${y}Z`} fill={color} />;
  }
  if (result === "cancelled")
    return <circle cx={x} cy={y} r={r - 0.75} fill="none" stroke={color} strokeWidth={1.5} />;
  return <circle cx={x} cy={y} r={r} fill={color} fillOpacity={big ? 1 : 0.8} />;
}

type Frame = { start: number; end: number; width: number };
const plotX = ({ start, end, width }: Frame, t: number) =>
  PAD.left + ((t - start) / (end - start)) * (width - PAD.left - PAD.right);
const bucketMiddle = (frame: Frame, at: number, bucketMs: number) =>
  plotX(frame, at + bucketMs / 2);

/** A y scale from 0 to a round number at or over `max`, with a tick every `step`. */
// The axis ends at the next whole step above the tallest mark with some headroom, so the tallest
// bar or dot doesn't touch the top. A fixed scale such as CPU (0 to 100%) passes `exact`.
function yScale(max: number, step: number, exact = false) {
  const top = Math.max(step, Math.ceil((exact ? max : max * 1.1) / step) * step);
  return {
    y: (value: number) => PAD.top + (1 - value / top) * PLOT_HEIGHT,
    ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step),
  };
}

type PlotProps = { frame: Frame; label: string };

/** The plot's axes and hover tooltip around its marks. */
function Plot({
  frame,
  label,
  ticks,
  y,
  tickText,
  onPointerMove,
  onLeave,
  tip,
  children,
}: PlotProps & {
  ticks: number[];
  y: (value: number) => number;
  tickText: (value: number) => string;
  onPointerMove?: (event: React.PointerEvent<SVGSVGElement>) => void;
  onLeave: () => void;
  tip: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <svg
        width={frame.width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        onPointerMove={onPointerMove}
        // A tap picks the nearest dot too, since a touch doesn't move before it lands.
        onPointerDown={onPointerMove}
        // A touch leaves as soon as the finger lifts: keep its tip until the next tap.
        onPointerLeave={(event) => event.pointerType !== "touch" && onLeave()}
        className="block"
      >
        <YAxis ticks={ticks} y={y} width={frame.width} tickText={tickText} />
        <XAxis frame={frame} />
        {children}
      </svg>
      {tip}
    </>
  );
}

const BAND = { fill: "var(--rr-go)", fillOpacity: 0.2 };
const LINE = {
  stroke: "var(--rr-go)",
  strokeWidth: 1.75,
  fill: "none",
  strokeLinejoin: "round",
} as const;

/**
 * The median of what succeeded in each bucket as a line, with the 10th to 90th percentile shaded
 * around it, and each failure (and cancelled run, when shown) marked where it ended.
 */
function Trend({
  points,
  metric,
  showCancelled,
  bucketMs,
  ...plot
}: PlotProps & {
  points: ChartPoint[];
  metric: Metric;
  showCancelled: boolean;
  bucketMs: number;
}) {
  const { frame } = plot;
  const { value, scale, tickText, valueText, tipText } = METRIC[metric];
  // A failure (or cancelled run) under the pointer, or the bucket nearest it. Held as is, so moving
  // within the same one doesn't re-render.
  const [hover, setHover] = useState<ChartPoint | Spread | null>(null);
  const stats = useMemo(
    () =>
      spreads(
        points.flatMap((point) =>
          point.result === "success" ? [{ at: point.at, value: value(point) }] : [],
        ),
        frame.start,
        frame.end,
        bucketMs,
      ),
    [points, value, frame.start, frame.end, bucketMs],
  );
  const marked = useMemo(
    () =>
      points
        .filter(
          (point) => point.result === "failed" || (showCancelled && point.result === "cancelled"),
        )
        .sort((a, b) => RESULT[a.result].z - RESULT[b.result].z),
    [points, showCancelled],
  );
  // How many failed in each bucket, for its tooltip.
  const failures = useMemo(() => {
    const counts = new Map<number, number>();
    for (const point of points) {
      if (point.result !== "failed") continue;
      const at = frame.start + bucketIndex(point.at, frame.start, frame.end, bucketMs) * bucketMs;
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    return counts;
  }, [points, frame.start, frame.end, bucketMs]);
  // The top fits the bands and the marks; a lone slow success no longer squashes the rest.
  const { y, ticks } = useMemo(() => {
    let max = 0;
    for (const spread of stats) max = Math.max(max, spread.p90);
    for (const point of marked) max = Math.max(max, value(point));
    return scale(max);
  }, [stats, marked, scale, value]);
  const slot = plotX(frame, frame.start + bucketMs) - plotX(frame, frame.start);

  // Drawn once per data or size change, not on every hover.
  const drawn = useMemo(() => {
    // Back-to-back buckets share one band and line; an empty bucket breaks them.
    const stretches: Spread[][] = [];
    for (const spread of stats) {
      const last = stretches.at(-1);
      if (last && spread.at - last.at(-1)!.at === bucketMs) last.push(spread);
      else stretches.push([spread]);
    }
    const x = (spread: Spread) => bucketMiddle(frame, spread.at, bucketMs);
    return (
      <>
        {stretches.map((stretch) => {
          const first = stretch[0]!;
          if (stretch.length === 1) {
            // A lone bucket: a short bar for its spread, its median across it.
            const half = Math.min(Math.max(slot / 4, 2), 6);
            const top = y(first.p90);
            return (
              <g key={first.at}>
                <rect
                  x={x(first) - half}
                  y={top}
                  width={half * 2}
                  height={Math.max(y(first.p10) - top, 1)}
                  rx={1.5}
                  {...BAND}
                />
                <line
                  x1={x(first) - half - 1}
                  x2={x(first) + half + 1}
                  y1={y(first.median)}
                  y2={y(first.median)}
                  {...LINE}
                />
              </g>
            );
          }
          const upper = stretch.map((spread) => `${x(spread)} ${y(spread.p90)}`);
          const lower = stretch.map((spread) => `${x(spread)} ${y(spread.p10)}`).reverse();
          return (
            <g key={first.at}>
              <path d={`M${[...upper, ...lower].join("L")}Z`} {...BAND} />
              <path
                d={`M${stretch.map((spread) => `${x(spread)} ${y(spread.median)}`).join("L")}`}
                {...LINE}
              />
            </g>
          );
        })}
        {marked.map((point) => (
          <Mark
            key={point.key}
            result={point.result}
            x={plotX(frame, point.at)}
            y={y(value(point))}
          />
        ))}
      </>
    );
  }, [stats, marked, frame, bucketMs, slot, y, value]);

  // A mark under the pointer, else the nearest bucket with something in it.
  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    let point: ChartPoint | null = null;
    let pointDistance = 10 ** 2;
    for (const each of marked) {
      const distance = (plotX(frame, each.at) - px) ** 2 + (y(value(each)) - py) ** 2;
      if (distance < pointDistance) [point, pointDistance] = [each, distance];
    }
    if (point) return setHover(point);
    let spread: Spread | null = null;
    let spreadDistance = Math.max(slot, 16);
    for (const each of stats) {
      const distance = Math.abs(bucketMiddle(frame, each.at, bucketMs) - px);
      if (distance < spreadDistance) [spread, spreadDistance] = [each, distance];
    }
    setHover(spread);
  }

  let tip: ReactNode = null;
  let highlight: ReactNode = null;
  if (hover && "key" in hover) {
    const hx = plotX(frame, hover.at);
    const hy = y(value(hover));
    tip = (
      <ChartTip x={hx} y={hy} width={frame.width}>
        <p className="max-w-56 truncate font-medium">{hover.name}</p>
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{tipText(hover)}</span>
          {` · ${RESULT[hover.result].label} · ${timeAgo(hover.at)}`}
        </p>
      </ChartTip>
    );
    highlight = (
      <>
        <circle
          cx={hx}
          cy={hy}
          r={7}
          fill="var(--card)"
          stroke="var(--foreground)"
          strokeOpacity={0.4}
        />
        <Mark result={hover.result} x={hx} y={hy} big />
      </>
    );
  } else if (hover) {
    const { at, count: succeeded, median, p90 } = hover;
    const failed = failures.get(at) ?? 0;
    const hx = bucketMiddle(frame, at, bucketMs);
    tip = (
      <ChartTip x={hx} y={y(p90)} width={frame.width}>
        <p className="font-medium">{bucketText(at, bucketMs)}</p>
        <TipRow label="Median" value={valueText(median)} />
        <TipRow label="90th percentile" value={valueText(p90)} />
        <TipRow label="Succeeded" value={String(succeeded)} />
        {failed > 0 && <TipRow label="Failed" value={String(failed)} />}
      </ChartTip>
    );
    highlight = (
      <>
        <rect
          x={plotX(frame, at)}
          y={PAD.top}
          width={slot}
          height={PLOT_HEIGHT}
          fill="var(--foreground)"
          fillOpacity={0.05}
        />
        <circle
          cx={hx}
          cy={y(median)}
          r={4}
          fill="var(--rr-go)"
          stroke="var(--card)"
          strokeWidth={1.5}
        />
      </>
    );
  }

  return (
    <Plot
      {...plot}
      ticks={ticks}
      y={y}
      tickText={tickText}
      onPointerMove={onPointerMove}
      onLeave={() => setHover(null)}
      tip={tip}
    >
      {highlight}
      {drawn}
    </Plot>
  );
}

/** A bucket's day, or its span of hours. */
const bucketText = (at: number, bucketMs: number) =>
  bucketMs >= DAY_MS
    ? zoneFormat(DAY_FORMAT).format(at)
    : zoneFormat(BUCKET_FORMAT).formatRange(at, at + bucketMs);

/** The legend's mark for a trend: a line through its band. */
function TrendMark() {
  return (
    <svg aria-hidden viewBox="0 0 14 10" className="h-2.5 w-3.5">
      <rect x={0} y={1} width={14} height={8} rx={1.5} {...BAND} />
      <line x1={0} x2={14} y1={5} y2={5} {...LINE} />
    </svg>
  );
}

type Bucket = Tally & { total: number };

function Bars({ tallies, bucketMs, ...plot }: PlotProps & { tallies: Tally[]; bucketMs: number }) {
  const { frame } = plot;
  const [hover, setHover] = useState<Bucket | null>(null);
  const buckets = useMemo(() => {
    const list: Bucket[] = [];
    for (let at = frame.start; at < frame.end; at += bucketMs)
      list.push({ at, total: 0, success: 0, failed: 0, cancelled: 0 });
    for (const tally of tallies) {
      const bucket = list[bucketIndex(tally.at, frame.start, frame.end, bucketMs)]!;
      for (const result of RESULTS) {
        bucket[result] += tally[result];
        bucket.total += tally[result];
      }
    }
    return list;
  }, [tallies, bucketMs, frame.start, frame.end]);
  const maxCount = Math.max(...buckets.map((bucket) => bucket.total), 1);
  const { y, ticks } = yScale(maxCount, countStep(maxCount));
  const slot = plotX(frame, frame.start + bucketMs) - plotX(frame, frame.start);
  // A 4px gap, or a quarter of the slot when bars are narrow (hours over a week).
  const barWidth = Math.max(Math.min(slot - Math.min(4, slot / 4), 24), 1);

  return (
    <Plot
      {...plot}
      ticks={ticks}
      y={y}
      tickText={String}
      onLeave={() => setHover(null)}
      tip={
        hover && (
          <ChartTip x={plotX(frame, hover.at) + slot / 2} y={PAD.top} width={frame.width}>
            <p className="font-medium">{bucketText(hover.at, bucketMs)}</p>
            {RESULTS.map((result) => (
              <TipRow
                key={result}
                mark={<ResultMark result={result} />}
                label={RESULT[result].label}
                value={String(hover[result])}
              />
            ))}
          </ChartTip>
        )
      }
    >
      {buckets.map((bucket) => {
        const x = plotX(frame, bucket.at);
        let below = 0;
        return (
          <g key={bucket.at} onPointerEnter={() => setHover(bucket)}>
            {/* The whole column is the hover target, not just the bar. */}
            <rect
              x={x}
              y={PAD.top}
              width={slot}
              height={PLOT_HEIGHT}
              fill={hover === bucket ? "var(--foreground)" : "transparent"}
              fillOpacity={0.05}
            />
            {RESULTS.map((result) => {
              if (!bucket[result]) return null;
              // A 2px gap between stacked segments; the top one gets rounded corners.
              const gap = below ? 2 : 0;
              const base = y(below) - gap;
              below += bucket[result];
              const d = topRounded(
                x + (slot - barWidth) / 2,
                base,
                barWidth,
                Math.max(base - y(below), 1),
                below === bucket.total ? 2 : 0,
              );
              return <path key={result} d={d} fill={RESULT[result].color} />;
            })}
          </g>
        );
      })}
    </Plot>
  );
}

function YAxis({
  ticks,
  y,
  width,
  tickText,
}: {
  ticks: number[];
  y: (value: number) => number;
  width: number;
  tickText: (value: number) => string;
}) {
  return ticks.map((value) => (
    <g key={value}>
      <line
        x1={PAD.left}
        x2={width - PAD.right}
        y1={y(value)}
        y2={y(value)}
        stroke={value === 0 ? "var(--rr-line)" : "var(--rr-line-soft)"}
      />
      <text
        x={PAD.left - 8}
        y={y(value) + 3.5}
        textAnchor="end"
        className="fill-muted-foreground text-[10px] tabular-nums"
      >
        {tickText(value)}
      </text>
    </g>
  ));
}

const HOUR_FORMAT: Intl.DateTimeFormatOptions = { hour: "numeric" };
const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const BUCKET_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
};

/** Up to each span, the gap between time labels; past the last, two days. */
const TICK_STEPS = [
  [12 * HOUR_MS, 3 * HOUR_MS],
  [2.5 * DAY_MS, 6 * HOUR_MS],
  [9 * DAY_MS, DAY_MS],
] as const;

/**
 * Time labels along the bottom, spaced for the span shown: every 3 or 6 hours, with the date at
 * each midnight, or every day or two.
 */
function XAxis({ frame }: { frame: Frame }) {
  const span = frame.end - frame.start;
  const stepMs = TICK_STEPS.find(([upTo]) => span <= upTo)?.[1] ?? 2 * DAY_MS;
  const hour = zoneFormat(HOUR_FORMAT);
  const day = zoneFormat(DAY_FORMAT);
  const ticks: number[] = [];
  for (let at = floorTo(frame.start, stepMs) + stepMs; at < frame.end; at += stepMs) {
    // Daylight saving can shift a step off the hour; snap back to it.
    ticks.push(floorTo(at, Math.min(stepMs, DAY_MS)));
  }
  const isDay = (at: number) => stepMs >= DAY_MS || startOfDay(at) === at;
  // Labels too close to the edges or each other are dropped, dates last.
  const kept: number[] = [];
  for (const dates of [true, false])
    for (const at of ticks) {
      const x = plotX(frame, at);
      if (isDay(at) !== dates || x > frame.width - PAD.right - 16) continue;
      if (kept.every((other) => Math.abs(plotX(frame, other) - x) >= 56)) kept.push(at);
    }
  return kept.map((at) => (
    <text
      key={at}
      x={plotX(frame, at)}
      y={HEIGHT - 6}
      textAnchor="middle"
      className="fill-muted-foreground text-[10px] tabular-nums"
    >
      {(isDay(at) ? day : hour).format(at)}
    </text>
  ));
}

/** The hour or midnight at or before `at`, on a `stepMs` boundary (1, 6 or 12 hours, or a day). */
const floorTo = (at: number, stepMs: number) =>
  startOfHours(at, Math.min(stepMs, DAY_MS) / HOUR_MS);

// 1, 2, 5, 10, 20, 50, ... so a count axis lands on round numbers with about three steps.
function countStep(max: number) {
  for (let scale = 1; ; scale *= 10)
    for (const step of [1, 2, 5]) if (step * scale * 3 >= max) return step * scale;
}

/** "30s", "5m", "90m": the axis needs no seconds once it counts minutes, and never counts hours. */
function axisTime(ms: number) {
  if (ms === 0) return "0";
  if (ms < 60_000) return `${ms / 1000}s`;
  return ms % 60_000 ? elapsed(ms) : `${ms / 60_000}m`;
}

// 256 MB, 512 MB, 1 GB, 2 GB, 4 GB, ... with about three steps to the top.
function memoryStep(max: number) {
  let step = 256;
  while (step * 3 < max) step *= 2;
  return step;
}

const UNNAMED = "Unnamed workflow";

/** Runs that finished, as chart points, one group per workflow. */
export const runPoints = (runs: Run[]): ChartPoint[] =>
  runs.flatMap((run) =>
    run.status === "completed" && run.wallMs !== null
      ? [
          {
            key: `${run.repositoryId}:${run.runId}:${run.runAttempt}`,
            at: run.updatedAt,
            ms: run.wallMs,
            result: resultOf(run.conclusion),
            name: run.title ?? run.workflow ?? UNNAMED,
            group: run.workflow ?? UNNAMED,
          },
        ]
      : [],
  );

/** Finished jobs, as chart points, one group per job name. */
export const jobPoints = (jobs: HistoryJob[]): ChartPoint[] =>
  jobs.map((job) => ({
    key: String(job.id),
    at: job.completedAt,
    ms: job.completedAt - job.startedAt,
    result: resultOf(job.conclusion),
    name: job.name,
    group: job.name,
    usage: job.usage,
  }));
