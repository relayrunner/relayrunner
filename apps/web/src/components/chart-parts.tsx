// Pieces the dashboard's SVG charts share: hover tooltips, stacked bar segments and the width
// a chart draws at.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

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
