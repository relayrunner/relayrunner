import { cn } from "@/lib/utils";

/**
 * A thin bar of minutes used against a quota: green, amber from 80%, and `over` (GitHub billing
 * overage) red. Used for GitHub's included minutes and Blacksmith's and Groundbox's free minutes.
 */
export function QuotaMeter({
  label,
  used,
  quota,
  over = false,
}: {
  label: string;
  used: number;
  quota: number;
  over?: boolean;
}) {
  const share = quota > 0 ? used / quota : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={quota}
      aria-valuenow={Math.round(Math.min(used, quota))}
      className="h-1.5 overflow-hidden rounded-full bg-raised-2"
    >
      <div
        className={cn(
          "h-full rounded-full",
          over ? "bg-destructive" : share >= 0.8 ? "bg-run" : "bg-go",
        )}
        style={{ width: `${Math.min(100, Math.max(share * 100, used ? 1 : 0))}%` }}
      />
    </div>
  );
}
