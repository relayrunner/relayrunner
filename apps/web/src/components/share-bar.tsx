// A thin bar split into each part's share of a whole, such as CI time by job type. Hovering a part,
// or its row elsewhere through `active`, fades the others and opens a hover card over it.
import type { ReactNode } from "react";
import { useState } from "react";
import { TIP_CARD } from "@/components/chart-parts";
import { cn } from "@/lib/utils";

/** The bar's track and its segments, for other bars that split a whole the same way. */
export const SHARE_STRIP = "flex h-2 gap-[3px]";
export const SHARE_SEGMENT = "h-full min-w-1 rounded-full";

export type SharePart = { key: string; value: number; fill: string; tip: ReactNode };

export function ShareBar({
  parts,
  label,
  active,
  onActive,
}: {
  parts: SharePart[];
  label: string;
  /** The part highlighted from outside the bar, such as a hovered table row. */
  active?: string | null;
  onActive?: (key: string | null) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!total) return null;
  const lit = hover ?? active;
  const point = (key: string | null) => {
    setHover(key);
    onActive?.(key);
  };
  // Where each part starts, as a share of the bar, for placing its card.
  let start = 0;
  const placed = parts.map((part) => {
    const at = { ...part, start: start / total, share: part.value / total };
    start += part.value;
    return at;
  });
  const shown = placed.find((part) => part.key === hover);

  return (
    <div className="relative">
      <div
        role="img"
        aria-label={label}
        className={SHARE_STRIP}
        onPointerLeave={(event) => event.pointerType !== "touch" && point(null)}
      >
        {placed.map((part) => (
          <span
            key={part.key}
            onPointerEnter={() => point(part.key)}
            onPointerDown={() => point(part.key)}
            className={cn(
              SHARE_SEGMENT,
              "transition-opacity",
              lit && lit !== part.key && "opacity-30",
            )}
            style={{ width: `${part.share * 100}%`, background: part.fill }}
          />
        ))}
      </div>
      {shown && (
        <div
          role="status"
          className={cn("absolute bottom-full mb-2", TIP_CARD)}
          style={
            shown.start + shown.share / 2 > 0.5
              ? { right: `${(1 - shown.start - shown.share) * 100}%` }
              : { left: `${shown.start * 100}%` }
          }
        >
          {shown.tip}
        </div>
      )}
    </div>
  );
}
