// Bars for how many things fell in each range, such as jobs by how long they ran or pull requests
// by their CI minutes. Bars stand side by side, one per range, labelled under the axis.
import { type PointerEvent, type ReactNode, useState } from "react";
import { ChartTip, CountGrid, countScale, topRounded, useWidth } from "@/components/chart-parts";

export type HistogramBar = { label: string; value: number; color: string; tip: ReactNode };
/** A dashed line across the bars at `at`, counted in bars from the left edge (1.5 is mid second). */
export type HistogramMarker = { at: number; label: string };

const PAD = { top: 18, right: 0, bottom: 22, left: 40 };

export function Histogram({
  bars,
  label,
  markers = [],
  height = 160,
}: {
  bars: HistogramBar[];
  label: string;
  markers?: HistogramMarker[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...bars.map((bar) => bar.value), 1);
  const plotHeight = height - PAD.top - PAD.bottom;
  const { y, ticks } = countScale(max, PAD.top, PAD.top + plotHeight);
  const slot = width ? (width - PAD.left - PAD.right) / bars.length : 0;
  const barWidth = Math.max(Math.min(slot - Math.min(6, slot / 4), 72), 1);
  const x = (at: number) => PAD.left + at * slot;
  // Labels too close to each other drop the right one, so they never overlap.
  const placed = markers
    .toSorted((a, b) => a.at - b.at)
    .filter((marker, i, all) => i === 0 || x(marker.at) - x(all[i - 1]!.at) > 64);

  function pointAt(event: PointerEvent<SVGSVGElement>) {
    if (!slot) return;
    const left = event.currentTarget.getBoundingClientRect().left;
    const index = Math.floor((event.clientX - left - PAD.left) / slot);
    setHover(index >= 0 && index < bars.length ? index : null);
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
          {bars.map((bar, i) => (
            <g key={bar.label}>
              <rect
                x={x(i)}
                y={PAD.top}
                width={slot}
                height={plotHeight}
                fill={hover === i ? "var(--foreground)" : "transparent"}
                fillOpacity={0.05}
              />
              {bar.value > 0 && (
                <path
                  d={topRounded(
                    x(i) + (slot - barWidth) / 2,
                    y(0),
                    barWidth,
                    Math.max(y(0) - y(bar.value), 1),
                    2,
                  )}
                  fill={bar.color}
                />
              )}
              <text
                x={x(i + 0.5)}
                y={height - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {bar.label}
              </text>
            </g>
          ))}
          {placed.map((marker) => (
            <g key={marker.label} className="pointer-events-none">
              <line
                x1={x(marker.at)}
                x2={x(marker.at)}
                y1={PAD.top - 4}
                y2={y(0)}
                stroke="var(--foreground)"
                strokeOpacity={0.55}
                strokeDasharray="3 3"
              />
              <text
                x={x(marker.at)}
                y={PAD.top - 7}
                textAnchor={x(marker.at) > width - 40 ? "end" : "middle"}
                className="fill-foreground text-[10px] font-medium"
              >
                {marker.label}
              </text>
            </g>
          ))}
        </svg>
      )}
      {hover !== null && bars[hover] && (
        <ChartTip x={x(hover + 0.5)} y={PAD.top} width={width}>
          {bars[hover].tip}
        </ChartTip>
      )}
    </div>
  );
}
