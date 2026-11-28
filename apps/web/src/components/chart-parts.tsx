// Pieces the dashboard's SVG charts share: hover tooltips, stacked bar segments and the width
// a chart draws at.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { periodStarts } from "@/lib/chart-trend";
import { startOfDay, startOfHours, zoneFormat } from "@/lib/time-zone";
import { cn, count } from "@/lib/utils";

/** A tooltip line: a label, with its value on the right. */
export function TipRow({ mark, label, value }: { mark?: ReactNode; label: string; value: string }) {
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground">
      {mark}
      {label}
      <span className="ml-auto pl-3 font-medium text-foreground tabular-nums">{value}</span>
    </p>
  );
}

/** A hover card's first line: a swatch and what's under the pointer, with a quiet note on the right. */
export function TipHead({
  color,
  mark,
  title,
  aside,
}: {
  /** A swatch of this fill before the title. */
  color?: string;
  /** Any other mark before the title, in place of a swatch. */
  mark?: ReactNode;
  title: string;
  aside?: string;
}) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
      {color && (
        <span aria-hidden className="size-2 shrink-0 rounded-[3px]" style={{ background: color }} />
      )}
      {mark}
      <span className="min-w-0 truncate">{title}</span>
      {aside && <span className="ml-auto pl-4 font-normal text-muted-foreground">{aside}</span>}
    </p>
  );
}

/** A hover card's one line on what the numbers mean. */
export function TipNote({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 leading-snug text-muted-foreground">{children}</p>;
}

/** A count for TipStats, its noun made plural to match: { value: "1.2K", unit: "jobs" }. */
export const countStat = (value: number, noun: string) => ({
  value: count(value),
  unit: value === 1 ? noun : `${noun}s`,
});

/** A hover card's numbers in one row, each a value with its unit after it: "369 jobs  15% of all". */
export function TipStats({ stats }: { stats: { value: string; unit?: string }[] }) {
  return (
    <p className="mt-1.5 flex flex-wrap gap-x-3 tabular-nums">
      {stats.map(({ value, unit }) => (
        <span key={unit ?? value}>
          <span className="font-medium text-foreground">{value}</span>
          {unit && <span className="text-muted-foreground"> {unit}</span>}
        </span>
      ))}
    </p>
  );
}

/** A bar segment standing on `bottom`, with its top corners rounded. */
export function topRounded(x: number, bottom: number, width: number, height: number, r: number) {
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

/** A hover card's box, positioned by whoever places it. */
export const TIP_CARD =
  "pointer-events-none z-10 grid w-max max-w-64 grid-cols-[minmax(0,1fr)] gap-0.5 rounded-lg border bg-popover px-3 py-2.5 text-xs shadow-lg";

/** A tooltip over the plot, kept inside it. */
export function ChartTip({
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
      className={cn("absolute", TIP_CARD)}
      style={{
        top: Math.max(y - 12, 0),
        ...(right ? { right: width - x + 12 } : { left: x + 12 }),
      }}
    >
      {children}
    </div>
  );
}

/** An element's width, kept up to date as it resizes. */
export function useWidth<T extends HTMLElement>() {
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

export const HOUR_FORMAT: Intl.DateTimeFormatOptions = { hour: "numeric" };
export const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/**
 * The axis labels that fit, taken in the order given so the first win (dates before hours): each
 * at least 56px from the others, and none past `maxX`.
 */
export function thinLabels(candidates: { x: number; text: string }[], maxX: number) {
  const kept: { x: number; text: string }[] = [];
  for (const label of candidates)
    if (label.x <= maxX && kept.every((other) => Math.abs(other.x - label.x) >= 56))
      kept.push(label);
  return kept;
}

/**
 * Labels under runs spaced by order rather than time, each run `slot` wide from `left`: the date
 * where each day starts, with a faint line from `top` to `bottom` between days. Over three days or
 * less, every few hours too where there's room.
 */
export function OrderAxis({
  times,
  left,
  slot,
  maxX,
  top,
  bottom,
}: {
  /** When each run finished, oldest first. */
  times: number[];
  left: number;
  slot: number;
  maxX: number;
  top: number;
  bottom: number;
}) {
  const days = periodStarts(times, (at) => startOfDay(at));
  const hours = days.length > 3 ? [] : periodStarts(times, (at) => startOfHours(at, 3));
  const day = zoneFormat(DAY_FORMAT);
  const hour = zoneFormat(HOUR_FORMAT);
  // A label sits at the left edge of its first run's column.
  const edge = (index: number) => left + index * slot;
  const kept = thinLabels(
    [
      ...days.map((index) => ({ x: edge(index), text: day.format(times[index]!) })),
      ...hours.map((index) => ({ x: edge(index), text: hour.format(times[index]!) })),
    ],
    maxX,
  );
  return (
    <>
      {days.slice(1).map((index) => (
        <line
          key={index}
          x1={edge(index)}
          x2={edge(index)}
          y1={top}
          y2={bottom}
          stroke="var(--rr-line)"
          strokeDasharray="2 3"
        />
      ))}
      {kept.map(({ x, text }) => (
        <text
          key={x}
          x={x}
          y={bottom + 16}
          className="fill-muted-foreground text-[10px] tabular-nums"
        >
          {text}
        </text>
      ))}
    </>
  );
}

// 1, 2, 5, 10, 20, 50, ... so the axis lands on round numbers with about three steps.
export function roundStep(max: number) {
  for (let scale = 1; ; scale *= 10)
    for (const step of [1, 2, 5]) if (step * scale * 3 >= max) return step * scale;
}

/** A count axis from 0 past `max` at round steps, between `top` and `bottom` px. */
export function countScale(max: number, top: number, bottom: number) {
  const step = roundStep(Math.max(max, 1));
  const end = Math.ceil((Math.max(max, 1) * 1.05) / step) * step;
  const y = (value: number) => top + (1 - value / end) * (bottom - top);
  const ticks = Array.from({ length: Math.round(end / step) + 1 }, (_, i) => i * step);
  return { y, ticks };
}

/** Gridlines at each tick, with its count on the left, ending at `left`. */
export function CountGrid({
  ticks,
  y,
  left,
  right,
}: {
  ticks: number[];
  y: (value: number) => number;
  left: number;
  right: number;
}) {
  return ticks.map((tick) => (
    <g key={tick}>
      <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
      <text
        x={left - 8}
        y={y(tick) + 3.5}
        textAnchor="end"
        className="fill-muted-foreground text-[10px] tabular-nums"
      >
        {count(tick)}
      </text>
    </g>
  ));
}
