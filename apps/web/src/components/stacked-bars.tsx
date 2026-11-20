// A bar per day (or week) stacked by series, as minutes or as each series' share of the bar. The
// Providers page stacks billed minutes by provider, the Router page runs by how they were routed.
import { type ReactNode, useState } from "react";
import { ChartTip, TipRow, topRounded, useWidth } from "@/components/chart-parts";
import { DAY_MS } from "@/lib/job-times";
import { shortDate, zoneFormat } from "@/lib/time-zone";
import { cn, count, percent } from "@/lib/utils";

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

// 1, 2, 5, 10, 20, 50, ... so the axis lands on round numbers with about three steps.
function roundStep(max: number) {
  for (let scale = 1; ; scale *= 10)
    for (const step of [1, 2, 5]) if (step * scale * 3 >= max) return step * scale;
}

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

/**
 * Bars stacked bottom up in `series` order. With `share`, every bar is as tall as the plot and
 * each series is its share of the bar. `format` writes a value for the tooltip.
 */
export function StackedBars({
  buckets,
  bucketMs,
  series,
  share = false,
  format,
  label,
  height = 200,
  footer,
  defs,
}: {
  buckets: StackedBucket[];
  bucketMs: number;
  series: Series[];
  share?: boolean;
  format: (value: number) => string;
  label: string;
  height?: number;
  footer?: (bucket: StackedBucket, total: number) => ReactNode;
  /** SVG patterns the series' colours refer to. */
  defs?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // The bar under the pointer, by index.
  const [hover, setHover] = useState<number | null>(null);
  const totals = buckets.map((b) => series.reduce((n, s) => n + (b.values[s.key] ?? 0), 0));
  const max = share ? 100 : Math.max(...totals, 1);
  const step = share ? 50 : roundStep(max);
  const top = share ? 100 : Math.ceil((max * 1.05) / step) * step;
  const plotHeight = height - PAD.top - PAD.bottom;
  const y = (value: number) => PAD.top + (1 - value / top) * plotHeight;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const slot = width ? (width - PAD.left - PAD.right) / buckets.length : 0;
  const barWidth = Math.max(Math.min(slot - Math.min(4, slot / 4), 28), 1);
  // About one date label per 70px.
  const labelEvery = Math.max(1, Math.ceil(70 / Math.max(slot, 1)));
  // Labels and the tooltip read midday, so a daylight saving change doesn't move the date.
  const noon = (bucket: StackedBucket) => bucket.start + DAY_MS / 2;
  const hovered = hover === null ? undefined : buckets[hover];

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          className="block"
          onPointerLeave={(event) => event.pointerType !== "touch" && setHover(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {share ? `${tick}%` : count(tick)}
              </text>
            </g>
          ))}
          {buckets.map((bucket, i) => {
            const x = PAD.left + i * slot;
            const total = totals[i] ?? 0;
            const scale = share ? (total ? 100 / total : 0) : 1;
            let below = 0;
            return (
              <g
                key={bucket.start}
                onPointerEnter={() => setHover(i)}
                onPointerDown={() => setHover(i)}
              >
                {/* The whole column is the hover target, not just the bar. */}
                <rect
                  x={x}
                  y={PAD.top}
                  width={slot}
                  height={plotHeight}
                  fill={hover === i ? "var(--foreground)" : "transparent"}
                  fillOpacity={0.05}
                />
                {series.map((s) => {
                  const value = (bucket.values[s.key] ?? 0) * scale;
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
                    below >= total * scale - 1e-9 ? 2 : 0,
                  );
                  return <path key={s.key} d={d} fill={s.color} />;
                })}
                {(buckets.length - 1 - i) % labelEvery === 0 && (
                  <text
                    // A label too close to the edge ends there, so it isn't cut off.
                    x={Math.min(x + slot / 2, width - PAD.right - EDGE)}
                    y={height - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {shortDate(noon(bucket))}
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
          <p className="font-medium">
            {bucketMs > DAY_MS ? "Week of " : ""}
            {zoneFormat(DAY_LABEL).format(noon(hovered))}
          </p>
          {series.toReversed().map((s) => {
            const value = hovered.values[s.key] ?? 0;
            if (!value) return null;
            const total = totals[hover] ?? 0;
            return (
              <TipRow
                key={s.key}
                mark={<Swatch color={s.swatch ?? s.color} className="size-2" />}
                label={s.label}
                value={share ? percent(total ? value / total : 0) : format(value)}
              />
            );
          })}
          {footer?.(hovered, totals[hover] ?? 0)}
        </ChartTip>
      )}
    </div>
  );
}
