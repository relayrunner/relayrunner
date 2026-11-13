import { ChartColumnStackedIcon, ChartScatterIcon } from "lucide-react";
import { Count } from "@/components/count";
import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/activity";
import { DAY_MS, niceStep, plural } from "@/lib/job-times";
import { type HistoryJob, isFailure, type JobUsage, type Run } from "@/lib/runs";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { formatMemory } from "@/lib/device";
import { count, elapsed, percent } from "@/lib/utils";

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
    scale: () => yScale(1, 0.25),
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

const HOUR_MS = 3_600_000;
const HEIGHT = 168;
const PAD = { top: 8, right: 8, bottom: 22, left: 40 };
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;
const BARS_FLAG = "rr:history-chart-bars";

/**
 * How long each finished run or job took over the page's range, one dot each, or how many
 * finished per hour (or 6 or 12 hours), with each result counted underneath.
 */
export const DurationChart = memo(function DurationChart({
  points,
  days,
  noun,
}: {
  points: ChartPoint[];
  days: number;
  /** "run" or "job". */
  noun: string;
}) {
  const [bars, setBars] = useState(() => readFlag(BARS_FLAG));
  const [picked, setMetric] = useState<Metric>("duration");
  const sampled = useMemo(() => points.filter((point) => point.usage), [points]);
  // CPU and memory only when some of what's shown reported them.
  const metric = sampled.length > 0 ? picked : "duration";
  const [ref, frame, bucketMs] = useFrame(days);
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

  return (
    <div className="grid gap-3 rounded-xl border bg-card px-4 pt-3 pb-4">
      <div className="flex items-center justify-between gap-3">
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
            {bars ? `${noun}s per ${per}` : `How long each ${noun} took`}
          </h2>
        )}
        <div role="group" aria-label="Chart" className="flex gap-1">
          <ChartToggle label="Duration" pressed={!bars} onClick={() => choose(false)}>
            <ChartScatterIcon />
          </ChartToggle>
          <ChartToggle label="Count" pressed={bars} onClick={() => choose(true)}>
            <ChartColumnStackedIcon />
          </ChartToggle>
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
            days={days}
            bucketMs={bucketMs}
            label={`${plural(points.length, noun)} per ${per}, by result`}
          />
        ) : (
          <Dots
            points={metric === "duration" ? points : sampled}
            metric={metric}
            frame={frame}
            days={days}
            label={`${METRIC[metric].label} of each of ${plural(points.length, noun)} over the last ${plural(days, "day")}`}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <ResultLegend counts={counts} />
        {!bars && metric !== "duration" && (
          <p>
            {count(sampled.length)} of {plural(points.length, noun)}, from connected machines
          </p>
        )}
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
  const [ref, frame, bucketMs] = useFrame(days, wanted);
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
            days={days}
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

/** Each result's mark, name and count. */
function ResultLegend({ counts }: { counts: Record<Result, number> }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1">
      {RESULTS.map((result) => (
        <li key={result} className="inline-flex items-center gap-1.5">
          <ResultMark result={result} />
          {RESULT[result].label}
          <span className="font-medium text-foreground tabular-nums">
            <Count value={counts[result]} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The bar width for a range: an hour for a day, 6 hours for a week, else 12. */
const bucketMsFor = (days: number) =>
  days <= 1 ? HOUR_MS : days <= 7 ? 6 * HOUR_MS : 12 * HOUR_MS;

const perBar = (bucketMs: number) =>
  bucketMs === HOUR_MS ? "hour" : bucketMs === DAY_MS ? "day" : `${bucketMs / HOUR_MS} hours`;

/** The plot's measured width and time range, in whole bars so the first and last are full width. */
function useFrame(days: number, bucketMs = bucketMsFor(days)) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const now = Date.now();
  const end = floorTo(now, bucketMs) + bucketMs;
  const start = floorTo(now - days * DAY_MS, bucketMs);
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
function yScale(max: number, step: number) {
  const top = Math.ceil(max / step) * step;
  return {
    y: (value: number) => PAD.top + (1 - value / top) * PLOT_HEIGHT,
    ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step),
  };
}

type PlotProps = { frame: Frame; days: number; label: string };

/** The plot's axes and hover tooltip around its marks. */
function Plot({
  frame,
  days,
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
        onPointerLeave={onLeave}
        className="block"
      >
        <YAxis ticks={ticks} y={y} width={frame.width} tickText={tickText} />
        <XAxis frame={frame} days={days} />
        {children}
      </svg>
      {tip}
    </>
  );
}

function Dots({ points, metric, ...plot }: PlotProps & { points: ChartPoint[]; metric: Metric }) {
  const { frame } = plot;
  const { value, scale, tickText, tipText } = METRIC[metric];
  const [hover, setHover] = useState<ChartPoint | null>(null);
  const { y, ticks } = useMemo(
    () => scale(Math.max(0, ...points.map((point) => value(point)))),
    [points, scale, value],
  );
  // Drawn once per data or size change, not on every hover.
  const marks = useMemo(
    () =>
      [...points]
        .sort((a, b) => RESULT[a.result].z - RESULT[b.result].z)
        .map((point) => (
          <Mark
            key={point.key}
            result={point.result}
            x={plotX(frame, point.at)}
            y={y(value(point))}
          />
        )),
    [points, frame, y, value],
  );

  // The nearest dot to the pointer, within reach.
  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    let best: ChartPoint | null = null;
    let bestDistance = 16 ** 2;
    for (const point of points) {
      const distance = (plotX(frame, point.at) - px) ** 2 + (y(value(point)) - py) ** 2;
      if (distance < bestDistance) [best, bestDistance] = [point, distance];
    }
    setHover(best);
  }
  const hx = hover ? plotX(frame, hover.at) : 0;
  const hy = hover ? y(value(hover)) : 0;

  return (
    <Plot
      {...plot}
      ticks={ticks}
      y={y}
      tickText={tickText}
      onPointerMove={onPointerMove}
      onLeave={() => setHover(null)}
      tip={
        hover && (
          <ChartTip x={hx} y={hy} width={frame.width}>
            <p className="max-w-56 truncate font-medium">{hover.name}</p>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{tipText(hover)}</span>
              {` · ${RESULT[hover.result].label} · ${timeAgo(hover.at)}`}
            </p>
          </ChartTip>
        )
      }
    >
      {marks}
      {hover && (
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
      )}
    </Plot>
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
      const index = Math.floor((tally.at - frame.start) / bucketMs);
      const bucket = list[Math.min(Math.max(index, 0), list.length - 1)]!;
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
            <p className="font-medium">
              {bucketMs >= DAY_MS
                ? DAY_FORMAT.format(hover.at)
                : BUCKET_FORMAT.formatRange(hover.at, hover.at + bucketMs)}
            </p>
            {RESULTS.map((result) => (
              <p key={result} className="flex items-center gap-1.5 text-muted-foreground">
                <ResultMark result={result} />
                {RESULT[result].label}
                <span className="ml-auto pl-3 font-medium text-foreground tabular-nums">
                  {hover[result]}
                </span>
              </p>
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

/** A bar segment standing on `bottom`, with its top corners rounded. */
function topRounded(x: number, bottom: number, width: number, height: number, r: number) {
  const radius = Math.min(r, width / 2, height);
  const top = bottom - height;
  return [
    `M${x} ${bottom}`,
    `V${top + radius}`,
    `Q${x} ${top} ${x + radius} ${top}`,
    `H${x + width - radius}`,
    `Q${x + width} ${top} ${x + width} ${top + radius}`,
    `V${bottom}Z`,
  ].join("");
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

const HOUR_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const BUCKET_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
});

/** Time labels along the bottom: every 6 hours for a day, else every day or two. */
function XAxis({ frame, days }: { frame: Frame; days: number }) {
  const stepMs = days <= 1 ? 6 * HOUR_MS : days <= 7 ? DAY_MS : 2 * DAY_MS;
  const format = stepMs < DAY_MS ? HOUR_FORMAT : DAY_FORMAT;
  const ticks: number[] = [];
  for (let at = floorTo(frame.start, stepMs) + stepMs; at < frame.end; at += stepMs) {
    // Daylight saving can shift a step off the hour; snap back to it.
    ticks.push(floorTo(at, Math.min(stepMs, DAY_MS)));
  }
  // Labels too close to the edges or each other are dropped.
  let last = -Infinity;
  return ticks.map((at) => {
    const x = plotX(frame, at);
    if (x - last < 56 || x > frame.width - PAD.right - 16) return null;
    last = x;
    return (
      <text
        key={at}
        x={x}
        y={HEIGHT - 6}
        textAnchor="middle"
        className="fill-muted-foreground text-[10px] tabular-nums"
      >
        {format.format(at)}
      </text>
    );
  });
}

/** A tooltip over the plot, kept inside it. */
function ChartTip({
  x,
  y,
  width,
  children,
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
}) {
  const right = x > width / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 grid gap-0.5 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
      style={{
        top: Math.max(y - 12, 0),
        ...(right ? { right: width - x + 12 } : { left: x + 12 }),
      }}
    >
      {children}
    </div>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The local hour or midnight at or before `at`, on a `stepMs` boundary (1, 6 or 12 hours, or a day). */
function floorTo(at: number, stepMs: number) {
  const date = new Date(at);
  date.setMinutes(0, 0, 0);
  const hours = Math.min(stepMs, DAY_MS) / HOUR_MS;
  date.setHours(date.getHours() - (date.getHours() % hours));
  return date.getTime();
}

// 1, 2, 5, 10, 20, 50, ... so a count axis lands on round numbers with about three steps.
function countStep(max: number) {
  for (let scale = 1; ; scale *= 10)
    for (const step of [1, 2, 5]) if (step * scale * 3 >= max) return step * scale;
}

/** "30s", "5m", "1h 30m": the axis needs no seconds once it counts minutes. */
function axisTime(ms: number) {
  if (ms === 0) return "0";
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < HOUR_MS) return ms % 60_000 ? elapsed(ms) : `${ms / 60_000}m`;
  const minutes = (ms % HOUR_MS) / 60_000;
  return minutes ? `${Math.floor(ms / HOUR_MS)}h ${minutes}m` : `${ms / HOUR_MS}h`;
}

// 256 MB, 512 MB, 1 GB, 2 GB, 4 GB, ... with about three steps to the top.
function memoryStep(max: number) {
  let step = 256;
  while (step * 3 < max) step *= 2;
  return step;
}

/** Runs that finished, as chart points. */
export const runPoints = (runs: Run[]): ChartPoint[] =>
  runs.flatMap((run) =>
    run.status === "completed" && run.wallMs !== null
      ? [
          {
            key: `${run.repositoryId}:${run.runId}:${run.runAttempt}`,
            at: run.updatedAt,
            ms: run.wallMs,
            result: resultOf(run.conclusion),
            name: run.title ?? run.workflow ?? "Unnamed workflow",
          },
        ]
      : [],
  );

/** Finished jobs, as chart points. */
export const jobPoints = (jobs: HistoryJob[]): ChartPoint[] =>
  jobs.map((job) => ({
    key: String(job.id),
    at: job.completedAt,
    ms: job.completedAt - job.startedAt,
    result: resultOf(job.conclusion),
    name: job.name,
    usage: job.usage,
  }));
