import { ChartColumnStackedIcon, ChartLineIcon } from "lucide-react";
import { Count } from "@/components/count";
import { memo, type ReactNode, useMemo, useState } from "react";
import {
  ChartTip,
  DAY_FORMAT,
  HOUR_FORMAT,
  OrderAxis,
  thinLabels,
  TipRow,
  topRounded,
  useWidth,
} from "@/components/chart-parts";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  bucketIndex,
  bucketMsFor,
  chartStart,
  groupsByCount,
  rollingSpreads,
} from "@/lib/chart-trend";
import { DAY_MS, HOUR_MS, niceStep, plural } from "@/lib/job-times";
import { type HistoryJob, isFailure, type JobUsage, type Run } from "@/lib/runs";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { formatMemory } from "@/lib/device";
import { formatTime, startOfDay, startOfHours, zoneFormat } from "@/lib/time-zone";
import { resolveRange, type TimeRange } from "@/lib/time-range";
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
    tipText: (point: ChartPoint) => string;
  }
> = {
  duration: {
    label: "Duration",
    value: (point) => point.ms,
    scale: (max) => yScale(Math.max(max, 1000), niceStep(Math.max(max, 1000) / 3)),
    tickText: axisTime,
    tipText: (point) => elapsed(point.ms),
  },
  cpu: {
    label: "P95 CPU",
    // Only points with usage are given CPU or memory.
    value: (point) => point.usage?.cpuP95 ?? 0,
    scale: () => yScale(1, 0.25, true),
    tickText: percent,
    tipText: ({ usage }) => `${percent(usage!.cpuP95)} of ${plural(usage!.cpus, "vCPU")}`,
  },
  memory: {
    label: "P95 memory",
    value: (point) => point.usage?.memoryP95Mb ?? 0,
    scale: (max) => yScale(Math.max(max, 256), memoryStep(Math.max(max, 256))),
    tickText: (mb) => (mb ? formatMemory(mb) : "0"),
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
 * How long one workflow's (or job's) runs took over the page's range, one dot per run in the order
 * they finished: the median of nearby runs as a line, the middle 80% shaded around it, and each
 * failure marked on top. Quiet hours take no room. Cancelled runs are hidden until their legend
 * entry is pressed. Or how many finished per bucket, by result, on a clock-time axis.
 */
export const DurationChart = memo(function DurationChart({
  points: all,
  range,
  noun,
  group,
  onGroup,
  groupLabel,
}: {
  points: ChartPoint[];
  range: TimeRange;
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
  const [ref, frame, bucketMs] = useFrame(range, { firstAt });
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
            width={frame.width}
            label={`${METRIC[metric].label} of each of the ${name}, in order: the median of nearby ${noun}s, the middle 80%, and each failure`}
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
            <p>
              One dot per {noun} in the order they finished, with the median of nearby {noun}s
            </p>
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
  range,
  noun,
  bucketMs: wanted,
}: {
  tallies: Tally[];
  range: TimeRange;
  noun: string;
  bucketMs?: number;
}) {
  const [ref, frame, bucketMs] = useFrame(range, { bucketMs: wanted });
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
  range: TimeRange,
  { firstAt, bucketMs: wanted }: { firstAt?: number; bucketMs?: number },
) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const span = resolveRange(range);
  const from = chartStart(span, firstAt);
  const bucketMs = wanted ?? bucketMsFor(span.to - from);
  // The bucket holding the range's last moment is the last.
  const end = floorTo(span.to - 1, bucketMs) + bucketMs;
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

/** The plot's axes and hover tooltip around its marks. */
function Plot({
  width,
  label,
  xAxis,
  ticks,
  y,
  tickText,
  onPointerMove,
  onLeave,
  tip,
  children,
}: {
  width: number;
  label: string;
  /** The labels along the bottom. */
  xAxis: ReactNode;
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
        className="block max-w-full"
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        onPointerMove={onPointerMove}
        // A tap picks the nearest dot too, since a touch doesn't move before it lands.
        onPointerDown={onPointerMove}
        // A touch leaves as soon as the finger lifts: keep its tip until the next tap.
        onPointerLeave={(event) => event.pointerType !== "touch" && onLeave()}
      >
        <YAxis ticks={ticks} y={y} width={width} tickText={tickText} />
        {xAxis}
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
 * Each run as a dot, oldest first and evenly spaced, so hours with nothing in them take no room.
 * The median of the successes around each one is a line, with their 10th to 90th percentile shaded
 * around it. Failures (and cancelled runs, when shown) are marked on top.
 */
function Trend({
  points,
  metric,
  showCancelled,
  width,
  label,
}: {
  points: ChartPoint[];
  metric: Metric;
  showCancelled: boolean;
  width: number;
  label: string;
}) {
  const { value, scale, tickText, tipText } = METRIC[metric];
  // The hovered run's place in `shown`. Held as is, so moving within its column doesn't re-render.
  const [hover, setHover] = useState<number | null>(null);
  const shown = useMemo(
    () =>
      points
        .filter((point) => showCancelled || point.result !== "cancelled")
        .sort((a, b) => a.at - b.at),
    [points, showCancelled],
  );
  // Each success's place in `shown`, with the spread of the successes around it.
  const successes = useMemo(() => {
    const list = shown.flatMap((point, index) => (point.result === "success" ? [index] : []));
    const stats = rollingSpreads(list.map((index) => value(shown[index]!)));
    return list.map((index, at) => ({ index, ...stats[at]! }));
  }, [shown, value]);
  // For each run, the median of the successes around it, for a failure's hover.
  const medians = useMemo(() => {
    const list: number[] = [];
    let next = 0;
    shown.forEach((_, index) => {
      while (next < successes.length - 1 && successes[next]!.index < index) next++;
      list.push(successes[next]?.median ?? 0);
    });
    return list;
  }, [shown, successes]);
  const slot = (width - PAD.left - PAD.right) / Math.max(shown.length, 1);
  const x = useMemo(() => (index: number) => PAD.left + (index + 0.5) * slot, [slot]);
  // The top fits the band and the marks; a lone slow success doesn't squash the rest.
  const { y, ticks } = useMemo(() => {
    let max = 0;
    for (const spread of successes) max = Math.max(max, spread.p90);
    for (const point of shown) if (point.result !== "success") max = Math.max(max, value(point));
    return scale(max);
  }, [successes, shown, scale, value]);

  // Drawn once per data or size change, not on every hover.
  const drawn = useMemo(() => {
    const marked = shown
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => point.result !== "success")
      .sort((a, b) => RESULT[a.point.result].z - RESULT[b.point.result].z);
    const r = slot < 4 ? 1.5 : slot < 12 ? 2.25 : 3;
    const upper = successes.map((spread) => `${x(spread.index)} ${y(spread.p90)}`);
    const lower = successes.map((spread) => `${x(spread.index)} ${y(spread.p10)}`).reverse();
    return (
      <>
        {successes.length > 1 && (
          <>
            {/* With only a few, the middle 80% of a handful of neighbours is just their range. */}
            {successes.length >= MIN_BAND && (
              <path d={`M${[...upper, ...lower].join("L")}Z`} {...BAND} />
            )}
            <path
              d={`M${successes.map((spread) => `${x(spread.index)} ${y(spread.median)}`).join("L")}`}
              {...LINE}
            />
          </>
        )}
        {successes.map(({ index }) => (
          <circle
            key={index}
            cx={x(index)}
            cy={y(value(shown[index]!))}
            r={successes.length === 1 ? 3.5 : r}
            fill={RESULT.success.color}
            fillOpacity={successes.length === 1 ? 0.8 : 0.45}
          />
        ))}
        {marked.map(({ point, index }) => (
          <Mark key={point.key} result={point.result} x={x(index)} y={y(value(point))} />
        ))}
      </>
    );
  }, [shown, successes, slot, x, y, value]);

  const axis = useMemo(
    () => (
      <OrderAxis
        times={shown.map((each) => each.at)}
        left={PAD.left}
        slot={slot}
        maxX={width - PAD.right - 32}
        top={PAD.top}
        bottom={HEIGHT - PAD.bottom}
      />
    ),
    [shown, slot, width],
  );

  // The run in the column under the pointer.
  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const index = Math.floor((px - PAD.left) / slot);
    setHover(Math.min(Math.max(index, 0), shown.length - 1));
  }

  let tip: ReactNode = null;
  let highlight: ReactNode = null;
  const point = hover === null ? undefined : shown[hover];
  if (hover !== null && point) {
    const hx = x(hover);
    const hy = y(value(point));
    tip = (
      <ChartTip x={hx} y={hy} width={width}>
        <p className="max-w-56 truncate font-medium">{point.name}</p>
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{tipText(point)}</span>
          {` · ${RESULT[point.result].label}`}
        </p>
        <p className="text-muted-foreground">{formatTime(point.at, FINISHED_FORMAT)}</p>
      </ChartTip>
    );
    highlight = (
      <>
        <rect
          x={hx - Math.max(slot, 8) / 2}
          y={PAD.top}
          width={Math.max(slot, 8)}
          height={PLOT_HEIGHT}
          fill="var(--foreground)"
          fillOpacity={0.05}
        />
        {point.result !== "success" && successes.length > 0 && (
          <circle cx={hx} cy={y(medians[hover]!)} r={3} fill="var(--rr-go)" />
        )}
        <circle
          cx={hx}
          cy={hy}
          r={7}
          fill="var(--card)"
          stroke="var(--foreground)"
          strokeOpacity={0.4}
        />
        <Mark result={point.result} x={hx} y={hy} big />
      </>
    );
  }

  return (
    <Plot
      width={width}
      label={label}
      xAxis={axis}
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

/** How many successes it takes before the middle 80% is shaded. */
const MIN_BAND = 12;

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

function Bars({
  tallies,
  bucketMs,
  frame,
  label,
}: {
  tallies: Tally[];
  bucketMs: number;
  frame: Frame;
  label: string;
}) {
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
      width={frame.width}
      label={label}
      xAxis={<XAxis frame={frame} />}
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

const BUCKET_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
};
const FINISHED_FORMAT: Intl.DateTimeFormatOptions = { ...BUCKET_FORMAT, minute: "2-digit" };

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
  const label = (at: number) => ({
    x: plotX(frame, at),
    text: (isDay(at) ? day : hour).format(at),
  });
  const kept = thinLabels(
    [...ticks.filter(isDay).map(label), ...ticks.filter((at) => !isDay(at)).map(label)],
    frame.width - PAD.right - 16,
  );
  return kept.map(({ x, text }) => (
    <text
      key={x}
      x={x}
      y={HEIGHT - 6}
      textAnchor="middle"
      className="fill-muted-foreground text-[10px] tabular-nums"
    >
      {text}
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
