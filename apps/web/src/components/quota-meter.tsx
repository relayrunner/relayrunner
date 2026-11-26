import { cn } from "@/lib/utils";

/**
 * A thin bar of minutes used against a quota: green, amber from 80%, and `over` (GitHub billing
 * overage) red. Used for GitHub's included minutes and Blacksmith's and Groundbox's free minutes.
 * `projected` adds a faint stretch out to where the cycle is headed at its pace, red when that
 * passes the quota.
 */
export function QuotaMeter({
  label,
  used,
  quota,
  over = false,
  projected,
}: {
  label: string;
  used: number;
  quota: number;
  over?: boolean;
  projected?: number;
}) {
  const width = (minutes: number) => `${Math.min(100, (minutes / quota) * 100)}%`;
  const share = quota > 0 ? used / quota : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={quota}
      aria-valuenow={Math.round(Math.min(used, quota))}
      className="relative h-1.5 overflow-hidden rounded-full bg-raised-2"
    >
      {quota > 0 && projected !== undefined && projected > used && (
        <div
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            projected > quota ? "bg-destructive/30" : "bg-go/25",
          )}
          style={{ width: width(projected) }}
        />
      )}
      <div
        className={cn(
          "relative h-full rounded-full",
          over ? "bg-destructive" : share >= 0.8 ? "bg-run" : "bg-go",
        )}
        style={{ width: `${Math.min(100, Math.max(share * 100, used ? 1 : 0))}%` }}
      />
    </div>
  );
}
