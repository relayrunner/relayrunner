import { isProviderId, PROVIDERS as PROVIDER_INFO, type ProviderId } from "@relayrunner/providers";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { PROVIDERS, runnerName, TILE } from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { Card } from "@/components/ui/card";
import { authDisabled } from "@/lib/auth-client";
import { clock, medianText, plural } from "@/lib/job-times";
import { getProviderReport, type ProviderReport, sampleProviderReport } from "@/lib/providers";
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
        to="/runners"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        Runners
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
          </>
        )}
      </div>

      {info.example && (
        <div className="grid max-w-3xl gap-3">
          <h2 className="font-semibold">Use it</h2>
          <p className="text-sm text-muted-foreground">
            Jobs ask for {info.name} with{" "}
            <code className="font-mono text-[13px]">{info.labels}</code> labels. Point a job's{" "}
            <code className="font-mono text-[13px]">runs-on</code> at one, and it shows up here a
            minute after it finishes.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[#1b1f24] px-4 py-3.5 font-mono text-[13px] leading-relaxed text-[#e6edf3]">
            {`jobs:\n  test:\n    runs-on: ${info.example}`}
          </pre>
        </div>
      )}
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium outline-none hover:bg-secondary/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {children}
      <ArrowUpRightIcon aria-hidden className="size-3.5" />
    </a>
  );
}

/** "3.4h", "52m", "40s": how long the jobs ran, together. */
function runTime(seconds: number) {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

const percent = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : "—";

function Totals({ report }: { report: ProviderReport }) {
  const { jobs, failures, runSeconds, stat } = report;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Tile label="Jobs" value={jobs.toLocaleString()} />
      <Tile label="Run time" value={runTime(runSeconds)} detail="All jobs, start to finish" />
      <Tile label="Typical job" value={medianText(stat)} detail="Median of successful jobs" />
      <Tile label="Queue wait" value={clock(stat.waitMs)} detail="Median, queued to started" />
      <Tile label="Failed" value={percent(failures, jobs)} detail={`${plural(failures, "job")}`} />
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card className="gap-0 px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 text-sm text-muted-foreground">{detail}</div>}
    </Card>
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
            {["Jobs", "Typical", "Run time", "Failed"].map((head) => (
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
              <Num>{runTime(runner.runSeconds)}</Num>
              <Num>{percent(runner.failures, runner.jobs)}</Num>
            </tr>
          ))}
        </tbody>
      </table>
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
