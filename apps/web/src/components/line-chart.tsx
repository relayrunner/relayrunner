// Lines over days (or weeks), one per series. Where a series has no value, a faint dashed line
// bridges the gap, unless the chart leaves gaps blank. The provider pages draw each runner type's queue wait, job time or failure rate.
import { useState } from "react";
import { ChartTip, TipRow, useWidth } from "@/components/chart-parts";
import { Swatch } from "@/components/stacked-bars";
import { DAY_MS } from "@/lib/job-times";
import { shortDate, zoneFormat } from "@/lib/time-zone";

export type Line = { key: string; label: string; color: string; values: (number | null)[] };

const PAD = { top: 10, right: 12, bottom: 22, left: 44 };
const EDGE = 18;
const DAY_LABEL: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

/**
 * Lines through `starts` (each point's bar start), from zero up to a round step past the highest
 * value. `ticks` picks the step for a highest value; `format` writes values for the axis and tooltip.
 */
export function LineChart({
  starts,
  bucketMs,
  lines,
  step,
  axis,
  format,
  label,
  ceiling = Infinity,
  height = 220,
  bridge = true,
}: {
  starts: number[];
  bucketMs: number;
  lines: Line[];
  step: (max: number) => number;
  axis: (value: number) => string;
  format: (value: number) => string;
  label: string;
  /** The most the axis goes up to, such as 100 for a percentage. */
  ceiling?: number;
  height?: number;
  /** Join values across missing ones with a faint dashed line. */
  bridge?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...lines.flatMap((line) => line.values.map((v) => v ?? 0)), 0);
  const tick = step(max || 1);
  const top = Math.min(Math.max(Math.ceil((max * 1.05) / tick), 1) * tick, Math.max(ceiling, tick));
  const ticks = Array.from({ length: Math.round(top / tick) + 1 }, (_, i) => i * tick);
  const plotHeight = height - PAD.top - PAD.bottom;
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const slot = plotWidth / Math.max(starts.length, 1);
  const x = (i: number) => PAD.left + (i + 0.5) * slot;
  const y = (value: number) => PAD.top + (1 - value / top) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(70 / Math.max(slot, 1)));
  // Labels and the tooltip read midday, so a daylight saving change doesn't move the date.
  const noon = (start: number) => start + DAY_MS / 2;

  // A path per unbroken run of values.
  const path = (values: (number | null)[]) => {
    let d = "";
    let open = false;
    values.forEach((value, i) => {
      if (value === null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  // A segment across each stretch of missing values, from the value before it to the one after.
  const bridges = (values: (number | null)[]) => {
    let d = "";
    let last: number | undefined;
    values.forEach((value, i) => {
      if (value === null) return;
      if (last !== undefined && last < i - 1)
        d += `M${x(last).toFixed(1)} ${y(values[last]!).toFixed(1)}L${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
      last = i;
    });
    return d;
  };

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          className="block max-w-full"
          onPointerMove={(event) => {
            const left = event.currentTarget.getBoundingClientRect().left;
            const i = Math.floor((event.clientX - left - PAD.left) / slot);
            setHover(i >= 0 && i < starts.length ? i : null);
          }}
          onPointerLeave={(event) => event.pointerType !== "touch" && setHover(null)}
        >
          {ticks.map((value) => (
            <g key={value}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(value) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {axis(value)}
              </text>
            </g>
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
              stroke="var(--foreground)"
              strokeOpacity={0.15}
            />
          )}
          {lines.map((line) => (
            <g key={line.key}>
              {bridge && (
                <path
                  d={bridges(line.values)}
                  fill="none"
                  stroke={line.color}
                  strokeOpacity={0.5}
                  strokeWidth={1.5}
                  strokeDasharray="3 4"
                />
              )}
              <path
                d={path(line.values)}
                fill="none"
                stroke={line.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {line.values.map((value, i) =>
                // A point on its own has no line, so it gets a dot; so does the hovered bar.
                value !== null &&
                (hover === i || (line.values[i - 1] == null && line.values[i + 1] == null)) ? (
                  <circle key={i} cx={x(i)} cy={y(value)} r={3} fill={line.color} />
                ) : null,
              )}
            </g>
          ))}
          {starts.map(
            (start, i) =>
              (starts.length - 1 - i) % labelEvery === 0 && (
                <text
                  key={start}
                  x={Math.min(Math.max(x(i), PAD.left + EDGE), width - PAD.right - EDGE)}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {shortDate(noon(start))}
                </text>
              ),
          )}
        </svg>
      )}
      {hover !== null && starts[hover] !== undefined && (
        <ChartTip x={x(hover)} y={PAD.top} width={width}>
          <p className="font-medium">
            {bucketMs > DAY_MS ? "Week of " : ""}
            {zoneFormat(DAY_LABEL).format(noon(starts[hover]))}
          </p>
          {lines.map((line) => (
            <TipRow
              key={line.key}
              mark={<Swatch color={line.color} className="size-2" />}
              label={line.label}
              value={line.values[hover] == null ? "—" : format(line.values[hover])}
            />
          ))}
        </ChartTip>
      )}
    </div>
  );
}
