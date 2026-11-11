import {
  dayMs,
  isProviderId,
  PROVIDERS as PROVIDER_INFO,
  type ProviderId,
  type RatePrices,
} from "@relayrunner/providers";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { PROVIDERS, runnerName, TILE } from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { authDisabled } from "@/lib/auth-client";
import { clock, medianText, plural } from "@/lib/job-times";
import {
  costText,
  getProviderReport,
  type ProviderReport,
  rateName,
  rateText,
  sampleProviderReport,
} from "@/lib/providers";
import { cn } from "@/lib/utils";

const RANGES = [1, 7, 14] as const;

function load(provider: ProviderId, days: number) {
  return authDisabled
    ? Promise.resolve(sampleProviderReport(provider, days))
    : getProviderReport(provider, days);
}

export const Route = createFileRoute("/_authed/_workspace/providers/$provider")({
  loader: ({ params }) => {
    if (!isProviderId(params.provider)) throw notFound();
    return load(params.provider, 14);
  },
  component: ProviderPage,
});

// Keyed by provider, so moving to another provider's page starts from its own loaded report.
function ProviderPage() {
  const first = Route.useLoaderData();
  return <ProviderView key={first.provider} first={first} />;
}

function ProviderView({ first }: { first: ProviderReport }) {
  const [report, setReport] = useState(first);
  const { provider } = report;
  const info = PROVIDER_INFO[provider];
  const { icon, tile } = PROVIDERS[provider];

  function chooseRange(days: number) {
    load(provider, days)
      .then(setReport)
      .catch(() => undefined);
  }

  return (
    <section className="grid max-w-5xl gap-8">
      <Link
        to="/providers"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        Providers
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className={cn(TILE, "size-12 rounded-[10px] [&_svg]:scale-150", tile)}>{icon}</span>
          <div className="grid min-w-0 gap-1">
            <h1 className="text-2xl leading-tight font-bold tracking-[-0.01em]">{info.name}</h1>
            <p className="text-muted-foreground">{info.summary}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {info.dashboardUrl && (
            <ExternalLink href={info.dashboardUrl}>Open dashboard</ExternalLink>
          )}
          {info.docsUrl && <ExternalLink href={info.docsUrl}>Docs</ExternalLink>}
        </div>
      </header>

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Your usage</h2>
          <RangePicker ranges={RANGES} days={report.days} onChange={chooseRange} />
        </div>
        {report.jobs === 0 ? (
          <p className="rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
            No jobs in this workspace ran on {info.name} in the last {plural(report.days, "day")}.
            Once one does, its numbers show up here.
          </p>
        ) : (
          <>
            <Totals report={report} />
            <Runners report={report} />
            <Workflows report={report} />
            <p className="text-xs text-muted-foreground">
              {costNote(report)} RelayRunner reads job timings from GitHub and never sees your bill,
              so costs are estimates at list prices (checked {report.pricesChecked}), before any
              plan allowance or discount.
            </p>
          </>
        )}
      </div>

      <Prices prices={report.prices} />

      {info.example && (
        <div className="grid max-w-3xl gap-3">
          <h2 className="font-semibold">Use it</h2>
          <p className="text-sm text-muted-foreground">
            Jobs ask for {info.name} with{" "}
            <code className="font-mono text-[13px]">{info.labels}</code> labels. Point a job's{" "}
            <code className="font-mono text-[13px]">runs-on</code> at one, and it shows up here a
            minute after it finishes.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-border/60 bg-[var(--rr-bg-deep)] px-4 py-3.5 font-mono text-[13px] leading-relaxed text-[var(--rr-ink-2)]">
            {`jobs:\n  test:\n    runs-on: ${info.example}`}
          </pre>
        </div>
      )}
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <Button asChild variant="outline">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ArrowUpRightIcon aria-hidden className="size-3.5" />
      </a>
    </Button>
  );
}

const percent = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : "—";

function costNote({ provider, unpricedJobs }: ProviderReport) {
  if (provider === "github") return "GitHub's standard runners are free in public repos.";
  if (unpricedJobs > 0)
    return `${plural(unpricedJobs, "job")} ran on runner types without a known price and are left out of the cost.`;
  return "";
}

function Totals({ report }: { report: ProviderReport }) {
  const { jobs, failures, billedMinutes, stat } = report;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatTile label="Jobs" value={jobs.toLocaleString()} />
      <StatTile
        label="Billed minutes"
        value={billedMinutes.toLocaleString()}
        detail="Rounded up per job"
      />
      <StatTile label="Estimated cost" value={costText(report)} detail="At list prices" />
      <StatTile label="Typical job" value={medianText(stat)} detail="Median of successful jobs" />
      <StatTile label="Queue wait" value={clock(stat.waitMs)} detail="Median, queued to started" />
      <StatTile label="Failed" value={percent(failures, jobs)} detail={plural(failures, "job")} />
    </div>
  );
}

/** Each runner type the jobs asked for, busiest first, with its share of the jobs. */
function Runners({ report }: { report: ProviderReport }) {
  const { provider, runners, jobs } = report;
  const { mono, bar, detail: showDetail } = PROVIDERS[provider];
  const showShare = runners.length > 1;
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <caption className="px-4 pt-3 pb-2 text-left font-semibold">Runner types</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="px-4 py-2 text-left font-normal">
              Runner
            </th>
            {["Jobs", "Typical", "Rate", "Est. cost", "Failed"].map((head) => (
              <th key={head} scope="col" className="px-4 py-2 text-right font-normal">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runners.map((runner) => (
            <tr key={runner.key} className="border-b last:border-0">
              <td className="px-4 py-2.5">
                <div className="grid min-w-48 gap-1.5">
                  <span title={runner.label} className="truncate">
                    <span className={cn(mono && "font-mono text-[13px]")}>
                      {runnerName(provider, runner.label)}
                    </span>
                    {showDetail && runner.detail && (
                      <span className="text-xs text-muted-foreground"> · {runner.detail}</span>
                    )}
                  </span>
                  {showShare && (
                    <span aria-hidden className="h-[3px] overflow-hidden rounded-full bg-raised-2">
                      <span
                        className={cn("block h-full rounded-full", bar)}
                        style={{ width: `${Math.max((runner.jobs / jobs) * 100, 2)}%` }}
                      />
                    </span>
                  )}
                </div>
              </td>
              <Num>{runner.jobs.toLocaleString()}</Num>
              <Num>{medianText(runner.stat)}</Num>
              <Num>{rateText(runner.perMinute)}</Num>
              <Num>{costText(runner)}</Num>
              <Num>{percent(runner.failures, runner.jobs)}</Num>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The workflows that sent the most jobs here. */
function Workflows({ report }: { report: ProviderReport }) {
  if (report.workflows.length === 0) return null;
  return (
    <div className="rounded-xl border bg-card">
      <h3 className="px-4 pt-3 pb-2 font-semibold">Busiest workflows</h3>
      <ul>
        {report.workflows.map((w) => (
          <li
            key={`${w.repository}/${w.workflow}`}
            className="flex items-baseline justify-between gap-4 border-t px-4 py-2.5 text-sm"
          >
            <span className="min-w-0 truncate">
              {w.workflow} <span className="text-xs text-muted-foreground">{w.repository}</span>
            </span>
            <span className="whitespace-nowrap text-muted-foreground tabular-nums">
              {plural(w.jobs, "job")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const dayText = (day: string) =>
  new Date(dayMs(day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

// When a price applied: "until May 1, 2026", "May 1, 2026 to Sep 1, 2026", or "from Dec 1, 2026"
// for one that hasn't started yet. The oldest price also covers anything earlier.
function spanText(history: RatePrices["history"], i: number, now: number) {
  const { from } = history[i]!;
  const until = history[i + 1]?.from;
  if (dayMs(from) > now) return `from ${dayText(from)}`;
  if (i === 0) return `until ${dayText(until!)}`;
  return `${dayText(from)} to ${dayText(until!)}`;
}

/**
 * The provider's list prices, and for a rate whose price has changed, its other prices and when
 * they applied. Jobs are priced at the rate on the day they ran.
 */
function Prices({ prices }: { prices: RatePrices[] }) {
  if (prices.length === 0) return null;
  const now = Date.now();
  const rows = prices.map(({ rate, per, history }) => {
    const current = history.findLastIndex((row, i) => i === 0 || dayMs(row.from) <= now);
    const unit = per === "vcpu" ? " per vCPU" : "";
    return {
      rate,
      today: `${rateText(history[current]?.usd ?? null)}${unit}`,
      // Every price but today's, newest first.
      changes: history
        .flatMap((row, i) =>
          i === current
            ? []
            : [{ key: row.from, text: `${rateText(row.usd)} ${spanText(history, i, now)}` }],
        )
        .toReversed(),
    };
  });
  const changed = rows.some((row) => row.changes.length > 0);
  return (
    <div className="grid max-w-3xl gap-3">
      <h2 className="font-semibold">List prices</h2>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-normal">
                Runner
              </th>
              <th scope="col" className="px-4 py-2 text-left font-normal">
                Today
              </th>
              {changed && (
                <th scope="col" className="px-4 py-2 text-left font-normal">
                  History
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rate} className="border-b align-top last:border-0">
                <td className="px-4 py-2.5">{rateName(row.rate)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap tabular-nums">{row.today}</td>
                {changed && (
                  <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                    {row.changes.map((change) => (
                      <div key={change.key}>{change.text}</div>
                    ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        From the provider's pricing page. A job is priced at the rate on the day it ran.
      </p>
    </div>
  );
}

function Num({ children }: { children: string }) {
  return (
    <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums">
      {children}
    </td>
  );
}
