import { Link } from "@tanstack/react-router";
import { ProviderMark, providerStyle, runnerName, type Provider } from "@/components/providers";
import { RunnerPanelLink } from "@/components/runner-panel-link";
import { medianText, p90Text, plural, type Stat } from "@/lib/job-times";
import { costText, type ProviderRunner, type ProviderSummary } from "@/lib/providers";
import type { TimeRange } from "@/lib/time-range";
import { cn } from "@/lib/utils";

// Runner | Size | Share of minutes | Jobs | Typical | Est. cost. On a phone only the runner (with its
// share under it), jobs and cost stay.
const COLUMNS =
  "grid-cols-[minmax(0,1fr)_3.5rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_4.5rem_minmax(5rem,10rem)_4rem_4.5rem_5.5rem]";
const WIDE = "hidden sm:block";

/**
 * Every runner cloud the workspace's jobs used, as one table: a row per provider with its totals,
 * then a row per runner type with its share of the provider's minutes, so big and small runners
 * are easy to tell apart. A provider with one runner type is just its own row.
 */
export function CloudRunnersTable({
  providers,
  range,
}: {
  providers: ProviderSummary[];
  /** The range when it isn't the default, carried to each provider's page. */
  range?: TimeRange;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div
        className={cn(
          "grid gap-x-4 border-b px-4 py-2 text-xs text-muted-foreground tabular-nums",
          COLUMNS,
        )}
      >
        <span>Runner</span>
        <span className={cn(WIDE, "text-right")}>Size</span>
        <span className={WIDE}>Share of minutes</span>
        <span className="text-right">Jobs</span>
        <span className={cn(WIDE, "text-right")}>Typical</span>
        <span className="text-right">Est. cost</span>
      </div>
      {providers.map((summary) => (
        <ProviderRows key={summary.provider} summary={summary} range={range} />
      ))}
    </div>
  );
}

function ProviderRows({ summary, range }: { summary: ProviderSummary; range?: TimeRange }) {
  const provider = summary.provider as Provider;
  const only = summary.runners.length === 1 ? summary.runners[0] : null;
  return (
    <section aria-label={providerStyle(provider).name} className="border-b last:border-b-0">
      <div
        className={cn(
          "grid items-center gap-x-4 bg-muted/40 px-4 py-2.5 text-sm tabular-nums",
          COLUMNS,
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <ProviderMark provider={provider} className="size-7 rounded-md" />
          <div className="grid min-w-0">
            <Link
              to="/providers/$provider"
              params={{ provider: summary.provider }}
              search={{ range }}
              className="w-fit truncate font-medium hover:underline hover:underline-offset-2"
            >
              {providerStyle(provider).name}
            </Link>
            {only && <RunnerName provider={provider} runner={only} className="text-xs" />}
          </div>
        </div>
        <span className={cn(WIDE, "text-right text-muted-foreground")}>
          {only ? vcpuText(only) : ""}
        </span>
        <span className={cn(WIDE, "text-xs text-muted-foreground")}>
          {summary.billedMinutes.toLocaleString()} min
        </span>
        <span className="text-right font-medium">{summary.jobs.toLocaleString()}</span>
        <span className={cn(WIDE, "text-right text-muted-foreground")}>
          {only ? <Typical stat={only.stat} /> : ""}
        </span>
        <span className="text-right font-medium">{costText(summary)}</span>
      </div>
      {!only &&
        summary.runners.map((runner) => (
          <RunnerRow
            key={runner.key}
            provider={provider}
            runner={runner}
            share={summary.billedMinutes > 0 ? runner.billedMinutes / summary.billedMinutes : 0}
          />
        ))}
    </section>
  );
}

function RunnerRow({
  provider,
  runner,
  share,
}: {
  provider: Provider;
  runner: ProviderRunner;
  share: number;
}) {
  const bar = <ShareBar share={share} label={`${Math.round(share * 100)}% of minutes`} />;
  return (
    <div
      className={cn(
        "grid items-center gap-x-4 border-t border-line-soft px-4 py-2 text-sm tabular-nums",
        COLUMNS,
      )}
    >
      {/* Indented under the provider's mark. */}
      <div className="grid min-w-0 gap-1.5 pl-10">
        <RunnerName provider={provider} runner={runner} />
        <div className="sm:hidden">{bar}</div>
      </div>
      <span className={cn(WIDE, "text-right text-muted-foreground")}>{vcpuText(runner)}</span>
      <div className={WIDE}>{bar}</div>
      <span className="text-right">{runner.jobs.toLocaleString()}</span>
      <span className={cn(WIDE, "text-right text-muted-foreground")}>
        <Typical stat={runner.stat} />
      </span>
      <span className="text-right">{costText(runner)}</span>
    </div>
  );
}

// The label without the provider's prefix, opening the runner's panel.
function RunnerName({
  provider,
  runner,
  className,
}: {
  provider: Provider;
  runner: ProviderRunner;
  className?: string;
}) {
  const { mono } = providerStyle(provider);
  return (
    <RunnerPanelLink
      runner={runner.key}
      title={runner.label}
      className={cn(
        "w-fit max-w-full truncate hover:underline hover:underline-offset-2",
        mono && "font-mono text-[0.92em]",
        className && "text-muted-foreground",
        className,
      )}
    >
      {runnerName(provider, runner.label)}
    </RunnerPanelLink>
  );
}

function ShareBar({ share, label }: { share: number; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="block h-1.5 overflow-hidden rounded-full bg-raised-2"
    >
      <span
        className="block h-full rounded-full bg-muted-foreground"
        style={{ width: `${Math.max(share * 100, 2)}%` }}
      />
    </span>
  );
}

function Typical({ stat }: { stat: Stat }) {
  if (stat.samples === 0) return <>—</>;
  return (
    <span title={`${p90Text(stat)} · ${plural(stat.samples, "run")}`}>{medianText(stat)}</span>
  );
}

// "4 vCPU", or "—" when neither the label nor the service says.
function vcpuText({ size }: Pick<ProviderRunner, "size">) {
  return size ? `${size.vcpus} vCPU` : "—";
}
