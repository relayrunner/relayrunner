import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { TimeRangePicker } from "@/components/range-picker";
import { StatTile } from "@/components/stat-tile";
import { Count } from "@/components/count";
import { PHONE_HIDDEN } from "@/components/ui/table";
import { loadPage, pageQuery, usePageReport } from "@/lib/query";
import { PageTabs, USAGE_TABS as TABS, viewOf } from "@/components/page-tabs";
import { RunFilterBar } from "@/components/run-filters";
import {
  hasRunFilters,
  parseRunFilters,
  PULL_REQUEST_PAGE,
  type PullRequestSort,
  RAW_RETENTION_DAYS,
  type RunFilters,
} from "@relayrunner/api-types";
import { PullRequestUsage } from "@/components/pull-request-usage";
import {
  getPullRequests,
  PULL_REQUEST_RANGES,
  type PullRequestReport,
  sortFromSearch,
  sortSearchParam,
} from "@/lib/pull-requests";
import {
  type RangeSearch,
  rangeSearch,
  textParam,
  unlessDefault,
  useSetSearch,
} from "@/lib/search-params";
import { type RangeOptions, rangePhrase, type TimeRange } from "@/lib/time-range";
import { cn, count } from "@/lib/utils";
import {
  type FreeCheckSavings,
  getCheckSavings,
  getUsage,
  minutes,
  money,
  type UsageReport,
  type UsageRow,
} from "@/lib/usage";
import { ExportMenu } from "@/components/export-menu";
import { JobLengths } from "@/components/job-lengths";
import type { ExportColumn } from "@/lib/table-export";

// As far back as the API keeps jobs, starting on this month since GitHub's included minutes reset
// on the first.
const RANGES: RangeOptions = {
  presets: ["24h", "7d", "14d", "30d", "90d", "week", "lastweek", "month", "lastmonth"],
};
const DEFAULT_RANGE: TimeRange = "month";

// No check savings with filters on: optimized checks aren't workflow runs, so filters leave them out.
type UsageData = { report: UsageReport; checks: FreeCheckSavings | null };

// The job report and what the free checks saved, over the same range.
function load(range: TimeRange, filters: RunFilters): Promise<UsageData> {
  const checks = hasRunFilters(filters) ? null : getCheckSavings(range);
  return Promise.all([getUsage(range, filters), checks]).then(([report, checks]) => ({
    report,
    checks,
  }));
}

const ranges = rangeSearch(RANGES, DEFAULT_RANGE);

type View = (typeof TABS)[number]["value"];
type UsageSearch = RangeSearch & RunFilters & { view?: View; repo?: string; sort?: string };
type Loaded =
  | { view: "overview"; usage: UsageData }
  | { view: "pull-requests"; pullRequests: PullRequestReport };

// The Overview's longer ranges reach past what the Pull requests view can read, which falls back
// to its default.
function pullRequestRange(search: UsageSearch): TimeRange {
  const range = ranges.rangeOf(search);
  return PULL_REQUEST_RANGES.presets.includes(range as never) ? range : DEFAULT_RANGE;
}

const usageQuery = (range: TimeRange, filters: RunFilters) =>
  pageQuery(["usage", range, filters], () => load(range, filters));
// One page of the Pull requests view: the first `limit` of one repo's, in the URL's order.
type PullRequestPage = { repository: string; sort: PullRequestSort; limit: number };
const pullRequestsQuery = (range: TimeRange, page: PullRequestPage) =>
  pageQuery(["usage", "pull-requests", range, page], () => getPullRequests(range, page));
const firstPage = (search: UsageSearch): PullRequestPage => ({
  repository: search.repo ?? "all",
  sort: sortFromSearch(search.sort),
  limit: PULL_REQUEST_PAGE,
});

export const Route = createFileRoute("/_authed/_workspace/usage")({
  validateSearch: (search: Record<string, unknown>): UsageSearch => ({
    view: viewOf(TABS, search.view),
    ...ranges.validateSearch(search),
    repo: textParam(search.repo),
    sort: sortSearchParam(sortFromSearch(search.sort)),
    ...parseRunFilters(search),
  }),
  loaderDeps: ({ search }) => ({ view: search.view ?? "overview" }),
  // Each view loads its first range here, and another range in the page.
  loader: async ({ deps: { view }, location }): Promise<Loaded> => {
    if (view === "pull-requests") {
      const search = location.search as UsageSearch;
      const range = pullRequestRange(search);
      return { view, pullRequests: await loadPage(pullRequestsQuery(range, firstPage(search))) };
    }
    return {
      view,
      usage: await loadPage(
        usageQuery(
          ranges.rangeOf(location.search as UsageSearch),
          parseRunFilters(location.search as UsageSearch),
        ),
      ),
    };
  },
  shouldReload: ({ cause }) => cause === "enter",
  component: UsagePage,
});

function UsagePage() {
  const loaded = Route.useLoaderData();
  return (
    <section>
      <PageHeader className="max-w-4xl" title="Usage">
        Every job in your connected repos, whichever runner took it. GitHub bills each job by the
        minute, rounded up, so a job that finishes in seconds still pays for a whole minute.
      </PageHeader>
      <div className="max-w-4xl">
        <PageTabs tabs={TABS} value={loaded.view} />
        {loaded.view === "pull-requests" ? (
          <PullRequests loaded={loaded.pullRequests} />
        ) : (
          <Overview loaded={loaded.usage} />
        )}
      </div>
    </section>
  );
}

function PullRequests({ loaded }: { loaded: PullRequestReport }) {
  const search = Route.useSearch();
  const range = pullRequestRange(search);
  const setSearch = useSetSearch<UsageSearch>();
  const first = firstPage(search);
  // "Show more" asks for a longer first page, back to one page when the range, repo or sort change.
  const key = JSON.stringify([range, first.repository, search.sort]);
  const [more, setMore] = useState({ key, limit: first.limit });
  const limit = more.key === key ? more.limit : first.limit;
  const { report } = usePageReport(pullRequestsQuery(range, { ...first, limit }), loaded);
  return (
    <SectionBoundary>
      <PullRequestUsage
        report={report}
        range={range}
        onRange={(next) => setSearch(ranges.toSearch(next))}
        repository={first.repository}
        onRepository={(next) => setSearch({ repo: unlessDefault(next, "all") })}
        sort={first.sort}
        onSort={(sort) => setSearch({ sort: sortSearchParam(sort) })}
        onMore={() => setMore({ key, limit: limit + PULL_REQUEST_PAGE })}
      />
    </SectionBoundary>
  );
}

function Overview({ loaded }: { loaded: UsageData }) {
  const search = Route.useSearch();
  const range = ranges.rangeOf(search);
  const filters = useMemo(() => parseRunFilters(search), [search]);
  const setSearch = useSetSearch<UsageSearch>();
  const {
    report: { report, checks },
  } = usePageReport(usageQuery(range, filters), loaded);

  const { totals } = report;
  const shortShare = totals.jobs ? Math.round((totals.shortJobs / totals.jobs) * 100) : 0;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <TimeRangePicker
          {...RANGES}
          value={range}
          onChange={(next) => setSearch(ranges.toSearch(next))}
        />
        <RunFilterBar range={range} value={filters} onChange={setSearch} />
      </div>
      {hasRunFilters(filters) && report.days > RAW_RETENTION_DAYS && (
        <p className="text-sm text-muted-foreground">
          With filters on, these count the last {RAW_RETENTION_DAYS} days.
        </p>
      )}

      {checks && checks.checks > 0 && (
        <SectionBoundary>
          <FreeChecks savings={checks} />
        </SectionBoundary>
      )}

      {totals.jobs === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
          No finished jobs in {rangePhrase(range)}. Jobs show up here once the GitHub App sees them
          run in a connected repo.
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

          <SectionBoundary>
            <JobLengths report={report} />
          </SectionBoundary>

          <SectionBoundary>
            <Table
              caption="By runner"
              exportAs={{
                name: "usage-by-runner",
                rows: report.byRunner,
                columns: RUNNER_EXPORT_COLUMNS,
              }}
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
          </SectionBoundary>

          <SectionBoundary>
            <Table
              caption="Repositories with the most short-job cost"
              exportAs={{
                name: "usage-by-repo",
                rows: report.byRepository,
                columns: REPOSITORY_EXPORT_COLUMNS,
              }}
              head={["Repository", "Jobs", "Under a minute", "Short-job cost"]}
              hideOnPhone={[1]}
              rows={report.byRepository.map((repo) => [
                <RepoName key="repo" repository={repo.repository} isPrivate={repo.private} />,
                <Count key="jobs" value={repo.jobs} />,
                <Count key="shortJobs" value={repo.shortJobs} />,
                money(repo.shortCost),
              ])}
            />
          </SectionBoundary>

          <p className="max-w-[62ch] text-sm text-muted-foreground">
            Estimates use GitHub's per-minute prices for private repos: ubuntu-slim $0.002,
            ubuntu-latest $0.006, windows-latest $0.010, macOS $0.062. Standard runners in public
            repos and self-hosted runners are free. Larger runners are priced as ubuntu-latest, so
            their cost is a floor. Skipped jobs and jobs cancelled before a runner took them aren't
            counted.
          </p>
        </>
      )}
    </div>
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

// The usage tables' exports, with money in USD.
const RUNNER_EXPORT_COLUMNS: ExportColumn<UsageRow>[] = [
  { header: "Runner", value: (row) => row.label },
  { header: "Rate (USD/min)", value: (row) => row.perMinute },
  { header: "Jobs", value: (row) => row.jobs },
  { header: "Under a minute", value: (row) => row.shortJobs },
  { header: "Run minutes", value: (row) => Math.round(row.runSeconds / 6) / 10 },
  { header: "Billed minutes", value: (row) => row.billedMinutes },
  { header: "Short-job cost (USD)", value: (row) => row.shortCost },
  { header: "Rounding cost (USD)", value: (row) => row.roundingCost },
  { header: "Total (USD)", value: (row) => row.cost },
];
const REPOSITORY_EXPORT_COLUMNS: ExportColumn<UsageReport["byRepository"][number]>[] = [
  { header: "Repo", value: (row) => row.repository },
  { header: "Public", value: (row) => row.private === false },
  { header: "Jobs", value: (row) => row.jobs },
  { header: "Under a minute", value: (row) => row.shortJobs },
  { header: "Short-job cost (USD)", value: (row) => row.shortCost },
];

/**
 * A captioned table, with an Export menu for `exportAs.rows` beside its caption. Columns whose
 * index is in `hideOnPhone` show from the sm breakpoint up.
 */
function Table<TData>({
  caption,
  exportAs,
  head,
  rows,
  hideOnPhone = [],
}: {
  caption: string;
  exportAs?: { name: string; rows: TData[]; columns: ExportColumn<TData>[] };
  head: string[];
  rows: ReactNode[][];
  hideOnPhone?: number[];
}) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 px-3 pt-3 pb-2 sm:px-4">
        <h3 className="font-semibold">{caption}</h3>
        {exportAs && (
          <div className="-my-1.5 -mr-2">
            <ExportMenu
              name={exportAs.name}
              rows={() => exportAs.rows}
              columns={exportAs.columns}
            />
          </div>
        )}
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
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
