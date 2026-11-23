import { Link } from "@tanstack/react-router";
import { TimerIcon } from "lucide-react";
import { providerStyle, runnerName, runnerSpec, TILE, type Provider } from "@/components/providers";
import { RunnerPanelLink } from "@/components/runner-panel-link";
import { medianText, p90Text, plural } from "@/lib/job-times";
import { costText, type ProviderRunner, type ProviderSummary } from "@/lib/providers";
import type { TimeRange } from "@/lib/time-range";
import { cn } from "@/lib/utils";

// Runner types a card shows; the footer links the rest.
const SHOWN = 2;

/** One card per runner cloud the workspace's jobs used, with a row for each runner type. */
export function CloudProviderCard({
  summary,
  range,
}: {
  summary: ProviderSummary;
  /** The range when it isn't the default, carried to the provider's page. */
  range?: TimeRange;
}) {
  const provider = summary.provider as Provider;
  const { name, icon, tile, bare, tint, bar, url } = providerStyle(provider);
  const total = summary.runners.reduce((sum, runner) => sum + runner.jobs, 0);
  // A share bar only says something when there's more than one runner type to compare.
  const showShare = summary.runners.length > 1;
  // Cards in a row stretch to the tallest, so a busy cloud keeps its top runner types and the
  // footer, pinned to the bottom, links the rest.
  const runners = summary.runners.slice(0, SHOWN);
  const count = summary.runners.length;
  return (
    <article
      aria-label={name}
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div className={cn("flex items-center gap-2.5 border-b border-line-soft px-4 py-3", tint)}>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${name}`}
            title={`Open ${name}`}
            className={cn(
              TILE,
              bare ?? tile,
              "outline-none hover:opacity-85 focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          >
            {icon}
          </a>
        ) : (
          <span className={cn(TILE, bare ?? tile)}>{icon}</span>
        )}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
          <Link
            to="/providers/$provider"
            params={{ provider: summary.provider }}
            search={{ range }}
            className="rounded-sm outline-none hover:underline hover:underline-offset-2 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {name}
          </Link>
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {plural(summary.jobs, "job")}
        </span>
      </div>
      {/* One grid for every row, so share bars and numbers line up down the card. */}
      <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto] divide-y divide-line-soft py-1">
        {runners.map((runner) => (
          <CloudRow
            key={runner.key}
            runner={runner}
            provider={provider}
            share={showShare && total > 0 ? runner.jobs / total : null}
            bar={bar}
          />
        ))}
      </ul>
      <div className="mt-auto flex min-h-10 min-w-0 items-center justify-between gap-3 bg-raised-2 px-4 py-2 text-xs text-muted-foreground tabular-nums">
        {count > SHOWN ? (
          <Link
            to="/providers/$provider"
            params={{ provider: summary.provider }}
            search={{ range }}
            className="rounded-sm outline-none hover:text-foreground hover:underline hover:underline-offset-2 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            All {count} runner types
          </Link>
        ) : (
          <span>{plural(count, "runner type")}</span>
        )}
        <span title="Est. cost at list prices">Est. {costText(summary)}</span>
      </div>
    </article>
  );
}

function CloudRow({
  runner,
  provider,
  share,
  bar,
}: {
  runner: ProviderRunner;
  provider: Provider;
  share: number | null;
  bar: string;
}) {
  const { label, stat } = runner;
  const { mono } = providerStyle(provider);
  const spec = runnerSpec(provider, runner);
  return (
    <li className="col-span-3 grid grid-cols-subgrid items-center gap-x-3 px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
      <div className="grid min-w-0 gap-1.5">
        <span title={label} className="truncate text-sm text-foreground">
          <RunnerPanelLink
            runner={runner.key}
            className={cn("hover:underline hover:underline-offset-2", mono && "font-mono")}
          >
            {runnerName(provider, label)}
          </RunnerPanelLink>
          {spec && <span className="text-xs text-muted-foreground"> · {spec}</span>}
        </span>
        {share !== null && (
          <span
            role="img"
            aria-label={`${Math.round(share * 100)}% of jobs`}
            title={`${Math.round(share * 100)}% of jobs`}
            className="h-[3px] overflow-hidden rounded-full bg-raised-2"
          >
            <span
              className={cn("block h-full rounded-full", bar)}
              style={{ width: `${Math.max(share * 100, 2)}%` }}
            />
          </span>
        )}
      </div>
      <span className="text-right">{plural(runner.jobs, "job")}</span>
      {stat.samples > 0 ? (
        <Link
          to="/performance"
          search={{ view: "runners" }}
          title={`Typical job · ${p90Text(stat)} · ${plural(stat.samples, "run")}`}
          className="flex items-center justify-end gap-1 hover:text-foreground"
        >
          <TimerIcon aria-hidden className="size-3.5 text-idle" />
          {medianText(stat)}
        </Link>
      ) : (
        <span />
      )}
    </li>
  );
}
