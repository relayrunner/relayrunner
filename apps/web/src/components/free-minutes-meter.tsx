import { type FreeMinutesProvider, RUNNER_LABELS } from "@relayrunner/runner-order";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { QuotaMeter } from "@/components/quota-meter";
import { counted, type FreeMinutes, getFreeMinutes } from "@/lib/free-minutes";
import { cn } from "@/lib/utils";

// Blacksmith's and Groundbox's free minutes this month as a bar, like GitHub's included minutes:
// on their Settings › Providers cards and their provider pages.

const count = (n: number) => Math.round(n).toLocaleString("en-US");

/** The day the next month's free minutes start: "Dec 1". */
function resets(cycleStart: string) {
  const start = new Date(cycleStart);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A counted free-minutes total: used against the quota, then what ran past it. */
export function FreeMinutesMeter({
  provider,
  minutes,
}: {
  provider: FreeMinutesProvider;
  minutes: FreeMinutes;
}) {
  const { usedMinutes: used, quotaMinutes: quota, burnRatePerHour } = minutes;
  const full = used >= quota;
  // Blacksmith counts free minutes as 2-vCPU minutes, so a 4-vCPU minute uses two.
  const unit = provider === "blacksmith" ? "2-vCPU min" : "min";
  const pace = full
    ? `${count(used - quota)} ${unit} past free`
    : burnRatePerHour
      ? `${count(burnRatePerHour)} min/hour`
      : null;
  return (
    <div className="grid gap-1.5 rounded-lg border bg-well px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span>
          <span className="text-muted-foreground">Free minutes </span>
          <span className="font-mono tabular-nums">
            {count(Math.min(used, quota))} / {count(quota)}
          </span>
          <span className="text-muted-foreground"> this month</span>
          <span className={cn("ml-1.5 font-mono tabular-nums", full && "text-run")}>
            {full ? "100" : Math.floor((used / quota) * 100)}%
          </span>
        </span>
        <span className="text-muted-foreground">
          {pace && `${pace} · `}resets {resets(minutes.cycleStart)}
        </span>
      </div>
      <QuotaMeter
        label={`${RUNNER_LABELS[provider]} free minutes used this month`}
        used={used}
        quota={quota}
      />
    </div>
  );
}

/**
 * The free minutes section of Blacksmith's and Groundbox's provider pages. Loads after the page;
 * without a connection it says where to make one.
 */
export function ProviderFreeMinutes({ provider }: { provider: FreeMinutesProvider }) {
  const [minutes, setMinutes] = useState<FreeMinutes | null>(null);
  useEffect(() => {
    let live = true;
    getFreeMinutes(provider).then(
      (read) => live && setMinutes(read),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [provider]);
  if (!minutes) return null;
  const label = RUNNER_LABELS[provider];
  const connect = minutes.reason === "not_connected";
  if (!counted(minutes) && !connect) return null;
  return (
    <div className="grid max-w-3xl gap-3">
      <h2 className="font-semibold">Free minutes</h2>
      {counted(minutes) ? (
        <FreeMinutesMeter provider={provider} minutes={minutes} />
      ) : (
        <p className="text-sm text-muted-foreground">
          <Link to="/settings/providers" className="text-go hover:text-go-hover">
            Connect {label}
          </Link>{" "}
          to see how many of its free minutes you've used this month.
        </p>
      )}
    </div>
  );
}
