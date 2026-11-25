// Pieces the dashboard's SVG charts share: hover tooltips, stacked bar segments and the width
// a chart draws at.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { periodStarts } from "@/lib/chart-trend";
import { startOfDay, startOfHours, zoneFormat } from "@/lib/time-zone";

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
