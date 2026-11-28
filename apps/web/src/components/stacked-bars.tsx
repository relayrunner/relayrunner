// A bar per hour, day or week stacked by series. The Providers page stacks billed minutes by provider,
// the Router page runs by how they were routed.
import { type PointerEvent, type ReactNode, useState } from "react";
import {
  ChartTip,
  CountGrid,
  countScale,
  TipHead,
  TipRow,
  topRounded,
  useWidth,
} from "@/components/chart-parts";
import { DAY_MS } from "@/lib/job-times";
import { shortDate, startOfDay, zoneFormat, zoneParts } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

/** A series' fill for bars, and for its swatch when that differs (stripes, say). */
export type Series<K extends string = string> = {
  key: K;
  label: string;
  color: string;
  swatch?: string;
};
export type StackedBucket = { start: number; values: Record<string, number> };

const PAD = { top: 10, right: 0, bottom: 22, left: 40 };
// Half a date label's width, about.
const EDGE = 18;
const DAY_LABEL: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
const HOUR_LABEL: Intl.DateTimeFormatOptions = { hour: "numeric" };
// How many hours apart hourly bars' labels may be.
const HOUR_STEPS = [1, 2, 3, 6, 12, 24];

/** An hourly bar's axis label: its hour ("3 PM"), or its date at midnight. */
const hourTick = (start: number) =>
  startOfDay(start) === start ? shortDate(start) : zoneFormat(HOUR_LABEL).format(start);

/**
 * A palette for series with no colour of their own, such as providers (several share their
 * brand's grey), in order of size. Past its end everything is grey.
 */
export const SERIES_COLORS = [
  "var(--job-test)",
  "var(--job-build)",
  "var(--job-lint)",
  "var(--job-e2e)",
  "var(--job-deploy)",
  "var(--job-other)",
];
export const seriesColor = (index: number) => SERIES_COLORS[index] ?? "var(--job-none)";

export function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)}
      style={{ background: color }}
    />
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <Swatch color={s.swatch ?? s.color} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Bars stacked bottom up in `series` order. `format` writes a value for the tooltip. */
export function StackedBars({
  buckets,
  bucketMs,
  series,
  format,
  label,
  height = 200,
  totalText,
  defs,
}: {
  buckets: StackedBucket[];
  bucketMs: number;
  series: Series[];
  format: (value: number) => string;
  label: string;
  height?: number;
  /** The bar's total for the top of its hover card, such as "1.2K min". */
  totalText?: (total: number) => string;
  /** SVG patterns the series' colours refer to. */
  defs?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // The bar under the pointer, by index.
  const [hover, setHover] = useState<number | null>(null);
  const totals = buckets.map((b) => series.reduce((n, s) => n + (b.values[s.key] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const plotHeight = height - PAD.top - PAD.bottom;
  const { y, ticks } = countScale(max, PAD.top, PAD.top + plotHeight);
  const slot = width ? (width - PAD.left - PAD.right) / buckets.length : 0;
  // Slim bars when there are many, wider (up to 72px) when a few weeks fill the plot.
  const barWidth = Math.max(
    Math.min(slot - Math.min(4, slot / 4), Math.max(28, slot * 0.4), 72),
    1,
  );
  const hourly = bucketMs < DAY_MS;
  // About one label per 70px: hourly bars' every 1, 2, 3, 6 or 12 hours from midnight, so they
  // land on round hours; day and week bars' counted back from the last.
  const labelEvery = Math.max(1, Math.ceil(70 / Math.max(slot, 1)));
  const labelHours = HOUR_STEPS.find((hours) => hours >= labelEvery) ?? 24;
  const labelled = (bucket: StackedBucket, i: number) =>
    hourly
      ? zoneParts(bucket.start).hour % labelHours === 0
      : (buckets.length - 1 - i) % labelEvery === 0;
  // Day labels and the tooltip read midday, so a daylight saving change doesn't move the date.
  const noon = (bucket: StackedBucket) => bucket.start + DAY_MS / 2;
  const tick = (bucket: StackedBucket) =>
    hourly ? hourTick(bucket.start) : shortDate(noon(bucket));
  const heading = (bucket: StackedBucket) =>
    hourly
      ? `${zoneFormat(DAY_LABEL).format(bucket.start)}, ${zoneFormat(HOUR_LABEL).format(bucket.start)} – ${zoneFormat(HOUR_LABEL).format(bucket.start + bucketMs)}`
      : `${bucketMs > DAY_MS ? "Week of " : ""}${zoneFormat(DAY_LABEL).format(noon(bucket))}`;
  const hovered = hover === null ? undefined : buckets[hover];
  // The bar under the pointer, from where it is across the plot, so the highlighted column and the
  // tooltip always match what's under it.
  function pointAt(event: PointerEvent<SVGSVGElement>) {
    if (!slot) return;
    const left = event.currentTarget.getBoundingClientRect().left;
    const index = Math.floor((event.clientX - left - PAD.left) / slot);
    setHover(index >= 0 && index < buckets.length ? index : null);
  }

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          className="block max-w-full"
          onPointerMove={pointAt}
          onPointerDown={pointAt}
          onPointerLeave={(event) => event.pointerType !== "touch" && setHover(null)}
        >
          <CountGrid ticks={ticks} y={y} left={PAD.left} right={width - PAD.right} />
          {buckets.map((bucket, i) => {
            const x = PAD.left + i * slot;
            const total = totals[i] ?? 0;
            let below = 0;
            return (
              // By position, so a bar never takes another's place when the range changes.
              <g key={i}>
                {/* The whole column is highlighted, not just the bar. */}
                <rect
                  x={x}
                  y={PAD.top}
                  width={slot}
                  height={plotHeight}
                  fill={hover === i ? "var(--foreground)" : "transparent"}
                  fillOpacity={0.05}
                />
                {series.map((s) => {
                  const value = bucket.values[s.key] ?? 0;
                  if (!value) return null;
                  // A 2px gap between stacked segments; the top one gets rounded corners.
                  const gap = below ? 2 : 0;
                  const base = y(below) - gap;
                  below += value;
                  const d = topRounded(
                    x + (slot - barWidth) / 2,
                    base,
                    barWidth,
                    Math.max(base - y(below), 1),
                    below >= total - 1e-9 ? 2 : 0,
                  );
                  return <path key={s.key} d={d} fill={s.color} />;
                })}
                {labelled(bucket, i) && (
                  <text
                    // A label too close to the edge ends there, so it isn't cut off.
                    x={Math.min(x + slot / 2, width - PAD.right - EDGE)}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {tick(bucket)}
                  </text>
                )}
              </g>
            );
          })}
          {defs && <defs>{defs}</defs>}
        </svg>
      )}
      {hover !== null && hovered && (
        <ChartTip x={PAD.left + (hover + 0.5) * slot} y={PAD.top} width={width}>
          <TipHead title={heading(hovered)} aside={totalText?.(totals[hover] ?? 0)} />
          {series.toReversed().map((s) => {
            const value = hovered.values[s.key] ?? 0;
            if (!value) return null;
            return (
              <TipRow
                key={s.key}
                mark={<Swatch color={s.swatch ?? s.color} className="size-2" />}
                label={s.label}
                value={format(value)}
              />
            );
          })}
        </ChartTip>
      )}
    </div>
  );
}
