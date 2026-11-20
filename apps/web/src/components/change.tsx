import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

/** A change against an earlier period, in whole percent: an arrow and the size, or "–" when unknown. */
export function Change({ value }: { value: number | null }) {
  if (value === null) return "–";
  if (value === 0) return "0%";
  const Icon = value > 0 ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon aria-label={value > 0 ? "Up" : "Down"} className="size-3.5" />
      {Math.abs(value)}%
    </span>
  );
}
