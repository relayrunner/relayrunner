import { ChartColumnStackedIcon, ChartScatterIcon } from "lucide-react";
import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/activity";
import { DAY_MS, niceStep, plural } from "@/lib/job-times";
import { type HistoryJob, isFailure, type Run } from "@/lib/runs";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { elapsed } from "@/lib/utils";

type Result = "success" | "failed" | "cancelled";

/** One finished run or job on the chart. */
export type ChartPoint = {
  key: string;
  /** When it finished. */
  at: number;
  ms: number;
  result: Result;
  name: string;
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
  const [ref, width] = useWidth<HTMLDivElement>();
  const bucketMs = days <= 1 ? HOUR_MS : days <= 7 ? 6 * HOUR_MS : 12 * HOUR_MS;
  // Whole buckets, so the bar view's first and last bars are as wide as the rest.
  const now = Date.now();
  const end = floorTo(now, bucketMs) + bucketMs;
  const start = floorTo(now - days * DAY_MS, bucketMs);
  const frame = useMemo(() => ({ start, end, width }), [start, end, width]);
  const counts = useMemo(() => {
    const totals: Record<Result, number> = { success: 0, failed: 0, cancelled: 0 };
    for (const point of points) totals[point.result]++;
    return totals;
  }, [points]);

  function choose(next: boolean) {
    setBars(next);
    saveFlag(BARS_FLAG, next);
  }
  const per = bucketMs === HOUR_MS ? "hour" : `${bucketMs / HOUR_MS} hours`;

  return (
    <div className="grid gap-3 rounded-xl border bg-card px-4 pt-3 pb-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium first-letter:uppercase">
          {bars ? `${noun}s per ${per}` : `How long each ${noun} took`}
        </h2>
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
        ) : width === 0 ? null : bars ? (
          <Bars
            points={points}
            frame={frame}
            days={days}
            bucketMs={bucketMs}
            label={`${plural(points.length, noun)} per ${per}, by result`}
          />
        ) : (
          <Dots
            points={points}
            frame={frame}
            days={days}
            label={`How long each of ${plural(points.length, noun)} took over the last ${plural(days, "day")}`}
          />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {RESULTS.map((result) => (
          <li key={result} className="inline-flex items-center gap-1.5">
            <ResultMark result={result} />
            {RESULT[result].label}
            <span className="font-medium text-foreground tabular-nums">{counts[result]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

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

function Dots({ points, ...plot }: PlotProps & { points: ChartPoint[] }) {
  const { frame } = plot;
  const [hover, setHover] = useState<ChartPoint | null>(null);
  const { y, ticks } = useMemo(() => {
    const maxMs = Math.max(...points.map((point) => point.ms), 1000);
    return yScale(maxMs, niceStep(maxMs / 3));
  }, [points]);
  // Drawn once per data or size change, not on every hover.
  const marks = useMemo(
    () =>
      [...points]
        .sort((a, b) => RESULT[a.result].z - RESULT[b.result].z)
        .map((point) => (
          <Mark key={point.key} result={point.result} x={plotX(frame, point.at)} y={y(point.ms)} />
        )),
    [points, frame, y],
  );

  // The nearest dot to the pointer, within reach.
  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    let best: ChartPoint | null = null;
    let bestDistance = 16 ** 2;
    for (const point of points) {
      const distance = (plotX(frame, point.at) - px) ** 2 + (y(point.ms) - py) ** 2;
      if (distance < bestDistance) [best, bestDistance] = [point, distance];
    }
    setHover(best);
  }
  const hx = hover ? plotX(frame, hover.at) : 0;
  const hy = hover ? y(hover.ms) : 0;

  return (
    <Plot
      {...plot}
      ticks={ticks}
      y={y}
      tickText={axisTime}
      onPointerMove={onPointerMove}
      onLeave={() => setHover(null)}
      tip={
        hover && (
          <ChartTip x={hx} y={hy} width={frame.width}>
            <p className="max-w-56 truncate font-medium">{hover.name}</p>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{elapsed(hover.ms)}</span>
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

type Bucket = { at: number; total: number } & Record<Result, number>;

function Bars({
  points,
  bucketMs,
  ...plot
}: PlotProps & { points: ChartPoint[]; bucketMs: number }) {
  const { frame } = plot;
  const [hover, setHover] = useState<Bucket | null>(null);
  const buckets = useMemo(() => {
    const list: Bucket[] = [];
    for (let at = frame.start; at < frame.end; at += bucketMs)
      list.push({ at, total: 0, success: 0, failed: 0, cancelled: 0 });
    for (const point of points) {
      const index = Math.floor((point.at - frame.start) / bucketMs);
      const bucket = list[Math.min(Math.max(index, 0), list.length - 1)]!;
      bucket[point.result]++;
      bucket.total++;
    }
    return list;
  }, [points, bucketMs, frame.start, frame.end]);
  const maxCount = Math.max(...buckets.map((bucket) => bucket.total), 1);
  const { y, ticks } = yScale(maxCount, countStep(maxCount));
  const slot = plotX(frame, frame.start + bucketMs) - plotX(frame, frame.start);
  const barWidth = Math.max(Math.min(slot - 4, 24), 2);

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
              {BUCKET_FORMAT.formatRange(hover.at, hover.at + bucketMs)}
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
  }));
