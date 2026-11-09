import { TriangleAlert } from "lucide-react";
import { type AccountUsage, unavailableText } from "@/lib/actions-usage";
import { cn } from "@/lib/utils";

// One GitHub account's Actions minutes this month (#116, #117), and the alarm when GitHub has
// billed overage. Used on Settings > GitHub.

const count = (n: number) => Math.round(n).toLocaleString("en-US");
const usd = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Red banner naming every account GitHub billed overage for this month. Null when none. */
export function OverageBanner({ accounts }: { accounts: AccountUsage[] }) {
  const over = accounts.filter((account) => account.netAmount > 0);
  if (over.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="grid gap-1">
        <p className="font-medium">
          {over.length === 1
            ? `GitHub is billing ${over[0]!.accountLogin} for Actions overage`
            : `GitHub is billing ${over.length} orgs for Actions overage`}
        </p>
        <p className="text-muted-foreground">
          {over
            .map((account) => `${account.accountLogin}: ${usd(account.netAmount)} this month`)
            .join(" · ")}
          . Usage went past the plan's included minutes. A "While under" limit on GitHub-hosted in
          the Router moves jobs to your machines before that happens.
        </p>
      </div>
    </div>
  );
}

/** Used vs included minutes, the burn rate, and why it can't be judged when it can't. */
export function ActionsMinutes({ usage }: { usage: AccountUsage }) {
  const unavailable = unavailableText(usage);
  const quota = usage.quotaMinutes;
  const share = quota ? usage.usedMinutes / quota : 0;
  const over = usage.netAmount > 0 || share >= 1;
  return (
    <div className="grid gap-1.5 rounded-lg border bg-well px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span>
          <span className="text-muted-foreground">Actions minutes </span>
          <span className="font-mono tabular-nums">
            {count(usage.usedMinutes)}
            {quota !== null && ` / ${count(quota)}`}
          </span>
          <span className="text-muted-foreground"> this month</span>
          {quota !== null && (
            <span className={cn("ml-1.5 font-mono tabular-nums", over && "text-destructive")}>
              {Math.floor(share * 100)}%
            </span>
          )}
        </span>
        <span className="text-muted-foreground">
          {usage.burnRatePerHour !== null && `${count(usage.burnRatePerHour)} min/hour · `}
          {usage.plan ? `${planName(usage.plan)} plan` : "Plan unknown"}
        </span>
      </div>
      {quota !== null && usage.status === "ok" && (
        <div
          role="meter"
          aria-label="Included Actions minutes used this month"
          aria-valuemin={0}
          aria-valuemax={quota}
          aria-valuenow={Math.round(usage.usedMinutes)}
          className="h-1.5 overflow-hidden rounded-full bg-raised-2"
        >
          <div
            className={cn(
              "h-full rounded-full",
              over ? "bg-destructive" : share >= 0.8 ? "bg-run" : "bg-go",
            )}
            style={{ width: `${Math.min(100, Math.max(share * 100, usage.usedMinutes ? 1 : 0))}%` }}
          />
        </div>
      )}
      {unavailable && <p className="text-xs text-muted-foreground">{unavailable}</p>}
    </div>
  );
}

const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1).replace(/_/g, " ");
