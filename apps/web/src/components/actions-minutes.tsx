import { Building2Icon, RefreshCwIcon, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { authDisabled } from "@/lib/auth-client";
import { githubInstallHref } from "@/lib/github";
import {
  type AccountUsage,
  type ActionsUsage,
  getActionsUsage,
  refreshActionsUsage,
  paceText,
  needsSpendApp,
  SPEND_APP_INSTALL_URL,
  unavailableText,
} from "@/lib/actions-usage";
import { QuotaMeter } from "@/components/quota-meter";
import { timeAgo } from "@/lib/machines";
import { cn, count as compactCount, percent } from "@/lib/utils";

// One GitHub account's Actions minutes this month (#116, #117), and the alarm when GitHub has
// billed overage. Used on Settings > GitHub and the GitHub provider page.

const count = (n: number) => Math.round(n).toLocaleString("en-US");
const usd = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Each account's Actions minutes this month, loaded after the page. Null until read, or on error. */
export function useActionsUsage() {
  const [usage, setUsage] = useState<ActionsUsage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    getActionsUsage().then(
      (read) => live && setUsage(read),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const refresh = () => {
    setRefreshing(true);
    refreshActionsUsage()
      .then(setUsage, () => undefined)
      .finally(() => setRefreshing(false));
  };
  return { usage, refresh, refreshing };
}

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
          . Usage went past the plan's included minutes. A minutes cap on GitHub-hosted in the
          Router moves jobs to your machines before that happens.
        </p>
      </div>
    </div>
  );
}

/**
 * Used vs included minutes, the burn rate, where the cycle is headed, and why it can't be judged
 * when it can't.
 */
export function ActionsMinutes({
  usage,
  onRefresh,
  refreshing = false,
}: {
  usage: AccountUsage;
  /** Reads GitHub billing again now. No button without it. */
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const unavailable = unavailableText(usage);
  const fix = fixLink(usage);
  const quota = usage.quotaMinutes;
  const share = quota ? usage.usedMinutes / quota : 0;
  const over = usage.netAmount > 0 || share >= 1;
  const pace = paceText(usage);
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
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span>
            {usage.burnRatePerHour !== null && `${count(usage.burnRatePerHour)} min/hour · `}
            {usage.enterprise ? (
              <>
                <Building2Icon aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
                Shared with {usage.enterprise}
              </>
            ) : usage.plan ? (
              `${planName(usage.plan)} plan`
            ) : (
              "Plan unknown"
            )}
          </span>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title={
                usage.readAt ? `Read from GitHub ${timeAgo(usage.readAt)}` : "Read from GitHub"
              }
              aria-label="Read minutes from GitHub again"
              className="rounded p-0.5 hover:text-foreground disabled:opacity-60"
            >
              <RefreshCwIcon aria-hidden className={cn("size-3.5", refreshing && "animate-spin")} />
            </button>
          )}
        </span>
      </div>
      {quota !== null && usage.status === "ok" && (
        <QuotaMeter
          label="Included Actions minutes used this month"
          used={usage.usedMinutes}
          quota={quota}
          over={over}
          projected={usage.projection?.projectedMinutes}
        />
      )}
      {usage.orgUsedMinutes !== undefined && usage.usedMinutes > 0 && (
        <p
          className="text-xs text-muted-foreground"
          title={`${count(usage.orgUsedMinutes)} minutes`}
        >
          {usage.accountLogin} used {compactCount(usage.orgUsedMinutes)} min of these (
          {percent(usage.orgUsedMinutes / usage.usedMinutes)}).
        </p>
      )}
      {pace && <p className="text-xs text-muted-foreground">{pace}</p>}
      {unavailable && (
        <p className="text-xs text-muted-foreground">
          {unavailable}
          {fix && (
            <>
              {" "}
              <a
                href={fix.href}
                {...(fix.external && { target: "_blank", rel: "noreferrer" })}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {fix.label}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** The link that fixes why an account's minutes can't be judged, when there is one. */
function fixLink(usage: AccountUsage) {
  if (needsSpendApp(usage))
    return { label: "Install RelayRunner Spend", href: SPEND_APP_INSTALL_URL, external: true };
  // GitHub's install page lists the enterprise as a target for its owners.
  if (usage.reason === "enterprise")
    return {
      label: "Install on your enterprise",
      href: githubInstallHref("/settings/github"),
      external: false,
    };
  return null;
}

const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1).replace(/_/g, " ");

/**
 * Each connected account's included Actions minutes, for the GitHub provider page. Loads after the
 * page; nothing shows until GitHub billing has been read.
 */
export function IncludedMinutes() {
  const { usage, refresh, refreshing } = useActionsUsage();
  if (!usage || usage.accounts.length === 0) return null;
  const several = usage.accounts.length > 1;
  return (
    <div className="grid max-w-3xl gap-3">
      <h2 className="font-semibold">Included minutes</h2>
      <OverageBanner accounts={usage.accounts} />
      <ul className="grid gap-3">
        {usage.accounts.map((account) => (
          <li key={account.installationId} className="grid gap-1.5">
            {several && <span className="text-sm font-medium">{account.accountLogin}</span>}
            <ActionsMinutes
              usage={account}
              onRefresh={authDisabled ? undefined : refresh}
              refreshing={refreshing}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
