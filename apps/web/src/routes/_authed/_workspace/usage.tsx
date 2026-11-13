import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { RangePicker } from "@/components/range-picker";
import { StatTile } from "@/components/stat-tile";
import { Count } from "@/components/count";
import { authDisabled } from "@/lib/auth-client";
import { count } from "@/lib/utils";
import {
  type FreeCheckSavings,
  getCheckSavings,
  getUsage,
  minutes,
  money,
  type UsageReport,
  type UsageRow,
  sampleCheckSavings,
} from "@/lib/usage";

const RANGES = [7, 30, 90] as const;

type UsageData = { report: UsageReport; checks: FreeCheckSavings };

// The job report and what the free checks saved, over the same range.
function load(days: number): Promise<UsageData> {
  if (authDisabled)
    return Promise.resolve({ report: sampleReport(days), checks: sampleCheckSavings(days) });
  return Promise.all([getUsage(days), getCheckSavings(days)]).then(([report, checks]) => ({
    report,
    checks,
  }));
}

export const Route = createFileRoute("/_authed/_workspace/usage")({
  loader: () => load(30),
  component: UsagePage,
});

function UsagePage() {
  const first = Route.useLoaderData();
  const [{ report, checks }, setData] = useState(first);
  const [days, setDays] = useState<number>(first.report.days);

  function chooseRange(next: number) {
    setDays(next);
    load(next)
      .then(setData)
      .catch(() => undefined);
  }

  const { totals } = report;
  const shortShare = totals.jobs ? Math.round((totals.shortJobs / totals.jobs) * 100) : 0;

  return (
    <section>
      <PageHeader title="Usage">
        Every job in your connected repos, whichever runner took it. GitHub bills each job by the
        minute, rounded up, so a job that finishes in seconds still pays for a whole minute.
      </PageHeader>
      <div className="grid max-w-4xl gap-6">
        <RangePicker ranges={RANGES} days={days} onChange={chooseRange} />

        {checks.checks > 0 && (
          <SectionBoundary>
            <FreeChecks savings={checks} />
          </SectionBoundary>
        )}

        {totals.jobs === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            No finished jobs in the last {report.days} days. Jobs show up here once the GitHub App
            sees them run in a connected repo.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile
                label={`Jobs under ${report.shortJobSeconds}s`}
                value={<Count value={totals.shortJobs} />}
                detail={`${shortShare}% of ${count(totals.jobs)} jobs`}
              />
              <StatTile
                label="Spent on short jobs"
                value={money(totals.shortCost)}
                detail={`${minutes(totals.shortBilledMinutes)} billed minutes`}
              />
              <StatTile
                label="Lost to rounding up"
                value={money(totals.roundingCost)}
                detail={`of ${money(totals.cost)} estimated for all jobs`}
              />
            </div>

            <Table
              caption="By runner"
              head={["Runner", "Jobs", "Under a minute", "Billed min", "Short-job cost", "Total"]}
              rows={report.byRunner.map((row) => [
                <span key="runner">
                  {row.label}
                  <span className="ml-1.5 text-muted-foreground">
                    {row.perMinute ? `${money(row.perMinute)}/min` : "free"}
                  </span>
                </span>,
                <Count key="jobs" value={row.jobs} />,
                <Count key="shortJobs" value={row.shortJobs} />,
                minutes(row.billedMinutes),
                money(row.shortCost),
                money(row.cost),
              ])}
            />

            <Table
              caption="Repositories with the most short-job cost"
              head={["Repository", "Jobs", "Under a minute", "Short-job cost"]}
              rows={report.byRepository.map((repo) => [
                <RepoName key="repo" repository={repo.repository} isPrivate={repo.private} />,
                <Count key="jobs" value={repo.jobs} />,
                <Count key="shortJobs" value={repo.shortJobs} />,
                money(repo.shortCost),
              ])}
            />

            <p className="max-w-[62ch] text-sm text-muted-foreground">
              Estimates use GitHub's per-minute prices for private repos: Linux 1-core $0.002, Linux
              2-core $0.006, Windows $0.010, macOS $0.062. Standard runners in public repos and
              self-hosted runners are free. Larger runners are priced as Linux 2-core, so their cost
              is a floor. Skipped jobs and jobs cancelled before a runner took them aren't counted.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

// The checks that ran with no Actions runner: the GitHub App's check runs and the Checks App's lint
// runs. Each stands in for a workflow job that would have billed a minute.
function FreeChecks({ savings }: { savings: FreeCheckSavings }) {
  const { runner } = savings;
  return (
    <div className="grid gap-3">
      <h2 className="font-semibold">Saved by optimized checks</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Checks run"
          value={<Count value={savings.checks} />}
          detail="PR title and lint, no Actions runner"
        />
        <StatTile
          label="Billed minutes saved"
          value={minutes(savings.checks)}
          detail={`one ${runner.label} minute per run`}
        />
        <StatTile
          label="Saved"
          value={money(savings.savedCost)}
          detail={`at ${money(runner.perMinute)}/min in private repos`}
        />
      </div>
      {savings.byCheck.length > 1 && (
        <Table
          caption="Optimized checks by check"
          head={["Check", "Runs", "Saved"]}
          rows={savings.byCheck.map((kind) => [
            kind.check,
            <Count key="checks" value={kind.checks} />,
            money(kind.savedCost),
          ])}
        />
      )}
      {savings.byRepository.length > 1 && (
        <Table
          caption="Optimized checks by repository"
          head={["Repository", "Runs", "Saved"]}
          rows={savings.byRepository.map((repo) => [
            <RepoName key="repo" repository={repo.repository} isPrivate={repo.private} />,
            <Count key="checks" value={repo.checks} />,
            money(repo.savedCost),
          ])}
        />
      )}
      <p className="max-w-[62ch] text-sm text-muted-foreground">
        Each PR title check, and each lint run (all of a commit's linters together, from a pull
        request or a <code>checks/lint</code> job), stands in for a workflow job on ubuntu-latest
        that would bill at least a whole minute. Public repos don't pay for standard runners, so
        their checks save minutes but no money.
      </p>
    </div>
  );
}

function RepoName({ repository, isPrivate }: { repository: string; isPrivate: boolean | null }) {
  return (
    <span className="font-mono">
      {repository}
      {isPrivate === false && (
        <span className="ml-1.5 font-sans text-muted-foreground">public, free</span>
      )}
    </span>
  );
}

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <caption className="px-4 pt-3 pb-2 text-left font-semibold">{caption}</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            {head.map((cell, i) => (
              <th
                key={cell}
                scope="col"
                className={`px-4 py-2 font-normal whitespace-nowrap ${i ? "text-right" : "text-left"}`}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b last:border-0">
              {row.map((cell, i) => (
                <td
                  key={i}
                  className={`px-4 py-2 ${i ? "text-right whitespace-nowrap tabular-nums" : ""}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TOTAL_KEYS = [
  "jobs",
  "shortJobs",
  "runSeconds",
  "billedMinutes",
  "shortBilledMinutes",
  "cost",
  "shortCost",
  "roundingCost",
] as const satisfies (keyof UsageReport["totals"])[];

// For local development without an API (auth disabled).
function sampleReport(days: number): UsageReport {
  const scale = days / 30;
  const row = (
    runnerClass: string,
    label: string,
    perMinute: number,
    jobs: number,
    shortJobs: number,
    billedMinutes: number,
  ): UsageRow => {
    const j = Math.round(jobs * scale);
    const s = Math.round(shortJobs * scale);
    const b = Math.round(billedMinutes * scale);
    return {
      runnerClass,
      label,
      perMinute,
      jobs: j,
      shortJobs: s,
      runSeconds: b * 40,
      billedMinutes: b,
      shortBilledMinutes: s,
      cost: b * perMinute,
      shortCost: s * perMinute,
      roundingCost: b * perMinute * 0.33,
    };
  };
  const byRunner = [
    row("macos", "macOS", 0.062, 120, 40, 900),
    row("linux-2-core", "Linux 2-core", 0.006, 2400, 1500, 6200),
    row("self-hosted", "Self-hosted", 0, 300, 90, 1400),
  ];
  return {
    days,
    shortJobSeconds: 60,
    totals: Object.fromEntries(
      TOTAL_KEYS.map((key) => [key, byRunner.reduce((total, r) => total + r[key], 0)]),
    ) as UsageReport["totals"],
    byRunner,
    byRepository: [
      { repository: "acme/app", private: true, jobs: 1800, shortJobs: 1100, shortCost: 8.9 },
      { repository: "acme/docs", private: false, jobs: 400, shortJobs: 380, shortCost: 0 },
    ],
  };
}
