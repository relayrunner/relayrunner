import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { TimeRangePicker } from "@/components/range-picker";
import { StatTile } from "@/components/stat-tile";
import { Count } from "@/components/count";
import { PHONE_HIDDEN } from "@/components/ui/table";
import { type RangeSearch, rangeSearch, useRangeReport, useSetSearch } from "@/lib/search-params";
import { type RangeOptions, rangePhrase, type TimeRange } from "@/lib/time-range";
import { cn, count } from "@/lib/utils";
import {
  type FreeCheckSavings,
  getCheckSavings,
  getUsage,
  minutes,
  money,
  type UsageReport,
} from "@/lib/usage";

// As far back as the API keeps jobs, starting on this month since GitHub's included minutes reset
// on the first.
const RANGES: RangeOptions = {
  presets: ["24h", "7d", "14d", "30d", "90d", "week", "lastweek", "month", "lastmonth"],
};
const DEFAULT_RANGE: TimeRange = "month";

type UsageData = { report: UsageReport; checks: FreeCheckSavings };

// The job report and what the free checks saved, over the same range.
function load(range: TimeRange): Promise<UsageData> {
  return Promise.all([getUsage(range), getCheckSavings(range)]).then(([report, checks]) => ({
    report,
    checks,
  }));
}

const { validateSearch, rangeOf, toSearch } = rangeSearch(RANGES, DEFAULT_RANGE);

export const Route = createFileRoute("/_authed/_workspace/usage")({
  validateSearch,
  loader: ({ location }) => load(rangeOf(validateSearch(location.search))),
  // A new range loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: UsagePage,
});

function UsagePage() {
  const range = rangeOf(Route.useSearch());
  const setSearch = useSetSearch<RangeSearch>();
  const first = Route.useLoaderData();
  const { report, checks } = useRangeReport(first, range, load);

  function chooseRange(next: TimeRange) {
    setSearch(toSearch(next));
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
        <TimeRangePicker {...RANGES} value={range} onChange={chooseRange} />

        {checks.checks > 0 && (
          <SectionBoundary>
            <FreeChecks savings={checks} />
          </SectionBoundary>
        )}

        {totals.jobs === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            No finished jobs in {rangePhrase(range)}. Jobs show up here once the GitHub App sees
            them run in a connected repo.
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
              hideOnPhone={[1, 3, 5]}
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
              hideOnPhone={[1]}
              rows={report.byRepository.map((repo) => [
                <RepoName key="repo" repository={repo.repository} isPrivate={repo.private} />,
                <Count key="jobs" value={repo.jobs} />,
                <Count key="shortJobs" value={repo.shortJobs} />,
                money(repo.shortCost),
              ])}
            />

            <p className="max-w-[62ch] text-sm text-muted-foreground">
              Estimates use GitHub's per-minute prices for private repos: ubuntu-slim $0.002,
              ubuntu-latest $0.006, windows-latest $0.010, macOS $0.062. Standard runners in public
              repos and self-hosted runners are free. Larger runners are priced as ubuntu-latest, so
              their cost is a floor. Skipped jobs and jobs cancelled before a runner took them
              aren't counted.
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

/** A captioned table. Columns whose index is in `hideOnPhone` show from the sm breakpoint up. */
function Table({
  caption,
  head,
  rows,
  hideOnPhone = [],
}: {
  caption: string;
  head: string[];
  rows: ReactNode[][];
  hideOnPhone?: number[];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <caption className="px-3 pt-3 pb-2 text-left font-semibold sm:px-4">{caption}</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            {head.map((cell, i) => (
              <th
                key={cell}
                scope="col"
                className={cn(
                  "px-3 py-2 font-normal sm:px-4 sm:whitespace-nowrap",
                  i ? "text-right" : "text-left",
                  hideOnPhone.includes(i) && PHONE_HIDDEN,
                )}
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
                  className={cn(
                    "px-3 py-2 sm:px-4",
                    i && "text-right whitespace-nowrap tabular-nums",
                    hideOnPhone.includes(i) && PHONE_HIDDEN,
                  )}
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
