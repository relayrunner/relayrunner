import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon } from "lucide-react";
import { useMemo } from "react";
import { TipRow } from "@/components/chart-parts";
import { Count } from "@/components/count";
import { Histogram } from "@/components/histogram";
import { StatTile } from "@/components/stat-tile";
import { createCellContext, DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { TimeRangePicker } from "@/components/range-picker";
import { RepoSelect } from "@/components/repo-select";
import { Button } from "@/components/ui/button";
import { minutesText } from "@/lib/job-times";
import {
  DEFAULT_PULL_REQUEST_SORT,
  PULL_REQUEST_PAGE,
  PULL_REQUEST_SORTS,
  pullRequestDate,
  type PullRequestSort,
} from "@relayrunner/api-types";
import {
  bucketPosition,
  PULL_REQUEST_RANGES,
  type PullRequestMinutes,
  type PullRequestReport,
  stateOf,
} from "@/lib/pull-requests";
import { pullRequestUrl } from "@/lib/runs";
import { isoTime, type ExportColumn } from "@/lib/table-export";
import type { TimeRange } from "@/lib/time-range";
import { formatDate, shortDate } from "@/lib/time-zone";
import { money } from "@/lib/usage";
import { percent } from "@/lib/utils";

const minutesOf = (minutes: number) => minutesText(minutes * 60_000);
const min = (minutes: number) => `${minutesOf(minutes)} min`;

/**
 * Usage › Pull requests: CI minutes per pull request across its pushes and re-runs, the typical
 * pull request over the range, and each one's estimated spend. The API narrows it to `repository`
 * ("all" for every one), sorts it by `sort` and sends a page of it; `onMore` asks for another.
 */
export function PullRequestUsage({
  report,
  range,
  onRange,
  repository,
  onRepository,
  sort,
  onSort,
  onMore,
}: {
  report: PullRequestReport;
  range: TimeRange;
  onRange: (range: TimeRange) => void;
  repository: string;
  onRepository: (repository: string) => void;
  sort: PullRequestSort;
  onSort: (sort: PullRequestSort) => void;
  onMore: () => void;
}) {
  const { summary, pullRequests } = report;
  const showRepository = report.repositories.length > 1 && repository === "all";
  const table = useMemo(
    () => ({ most: Math.max(0, ...pullRequests.map((pr) => pr.minutes)), showRepository }),
    [pullRequests, showRepository],
  );
  const sorting = useMemo(() => [sort], [sort]);
  const left = summary.count - pullRequests.length;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <TimeRangePicker {...PULL_REQUEST_RANGES} value={range} onChange={onRange} />
        <RepoSelect value={repository} repositories={report.repositories} onChange={onRepository} />
      </div>

      {summary.count === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
          No pull request jobs in this range. Each pull request shows up here once a workflow runs
          for it in a connected repo.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              label="Typical pull request"
              value={min(summary.minutes.median)}
              detail={`p90 ${min(summary.minutes.p90)}, average ${min(summary.minutes.average)}`}
            />
            <StatTile
              label="Spend per pull request"
              value={money(summary.cost.median)}
              detail={`average ${money(summary.cost.average)}, ${money(summary.cost.total)} in all`}
            />
            <StatTile
              label="Pull requests"
              value={<Count value={summary.count} />}
              detail={`${percent(summary.prShare)} of CI minutes, ${percent(summary.rerunShare)} from re-runs`}
            />
          </div>

          <Spread summary={summary} />

          <TableContext value={table}>
            <DataTable
              columns={columns}
              data={pullRequests}
              getRowId={(pr) => `${pr.repository}#${pr.number}`}
              sorting={sorting}
              onSortingChange={([next]) => onSort(sortOf(next))}
              exportAs={{
                name: repository === "all" ? "pull-requests" : `pull-requests-${repository}`,
                columns: EXPORT_COLUMNS,
              }}
            />
          </TableContext>
          {left > 0 && (
            <Button variant="outline" className="justify-self-center" onClick={onMore}>
              Show {Math.min(left, PULL_REQUEST_PAGE)} more of {summary.count}
            </Button>
          )}
        </>
      )}

      <p className="max-w-[62ch] text-sm text-muted-foreground">
        Minutes are the time each pull request's jobs ran, over every push and re-run in the range.
        Pushes to a branch before its pull request opened count toward it. Typical is the median
        pull request. Date is when it merged, or opened if it hasn't merged. Spend uses the same
        per-minute estimates as the Overview, after GitHub rounds each job up to a whole minute.
      </p>
    </div>
  );
}

const bucketLabel = ({ from, to }: { from: number; to: number | null }) =>
  to === null ? `${minutesOf(from)}+` : from ? `${minutesOf(from)}–${minutesOf(to)}` : `<${to}`;

/**
 * How many pull requests took how many minutes, with the typical one and p90 marked, so a few
 * heavy pull requests stand out from the usual.
 */
function Spread({ summary }: { summary: PullRequestReport["summary"] }) {
  if (summary.count < 5) return null;
  const { buckets } = summary;
  const { median, p90, total } = summary.minutes;
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <div>
        <h2 className="text-sm font-semibold">Minutes per pull request</h2>
        <p className="text-sm text-muted-foreground">How many pull requests used each amount.</p>
      </div>
      <Histogram
        label="Pull requests by the CI minutes they used"
        markers={[
          { at: bucketPosition(buckets, median), label: "Typical" },
          { at: bucketPosition(buckets, p90), label: "p90" },
        ]}
        bars={buckets.map((bucket) => ({
          label: bucketLabel(bucket),
          value: bucket.count,
          color: "var(--rr-go)",
          tip: (
            <>
              <p className="font-medium">{bucketLabel(bucket)} min</p>
              <TipRow label="Pull requests" value={String(bucket.count)} />
              <TipRow label="Minutes" value={minutesOf(bucket.minutes)} />
              <TipRow
                label="Share of minutes"
                value={percent(total ? bucket.minutes / total : 0)}
              />
            </>
          ),
        }))}
      />
    </section>
  );
}

// The most minutes any pull request in the table used, for the bars beside each one's minutes.
const [TableContext, useTableContext] = createCellContext<{
  most: number;
  showRepository: boolean;
}>("Pull requests");

/** A pull request's minutes as a bar against the most, its re-run part in a lighter shade. */
function MinutesBar({ pr }: { pr: PullRequestMinutes }) {
  const { most } = useTableContext();
  const width = (minutes: number) => `${most ? (minutes / most) * 100 : 0}%`;
  return (
    <span aria-hidden className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-muted sm:flex">
      <span
        className="h-full bg-[var(--rr-go)]"
        style={{ width: width(pr.minutes - pr.rerunMinutes) }}
      />
      <span
        className="h-full bg-[var(--rr-go)] opacity-40"
        style={{ width: width(pr.rerunMinutes) }}
      />
    </span>
  );
}

// An export names each pull request in full, with its link, and keeps spend in USD.
const EXPORT_COLUMNS: ExportColumn<PullRequestMinutes>[] = [
  { header: "Repo", value: (pr) => pr.repository },
  { header: "Number", value: (pr) => pr.number },
  { header: "Title", value: (pr) => pr.title },
  { header: "URL", value: (pr) => pullRequestUrl(pr.repository, pr.number) },
  { header: "Opened", value: (pr) => isoTime(pr.openedAt) },
  { header: "Merged", value: (pr) => isoTime(pr.mergedAt) },
  { header: "Minutes", value: (pr) => pr.minutes },
  { header: "Re-run minutes", value: (pr) => pr.rerunMinutes },
  { header: "Commits", value: (pr) => pr.commits },
  { header: "Est. spend (USD)", value: (pr) => pr.cost },
];

const dateOf = (pr: PullRequestMinutes) => pullRequestDate(pr).at;

/** A sort the table hands back, as one the API takes: the default when it's none of those. */
const sortOf = (sort: { id: string; desc: boolean } | undefined): PullRequestSort =>
  sort && PULL_REQUEST_SORTS.includes(sort.id as never)
    ? (sort as PullRequestSort)
    : DEFAULT_PULL_REQUEST_SORT;

const STATE_ICON = {
  open: GitPullRequestIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
};

// What the Date column shows for a pull request, for its hover text.
function dateTitle(pr: PullRequestMinutes) {
  const { label, at } = pullRequestDate(pr);
  return `${label} ${formatDate(at)}`;
}

/** A pull request's title over two lines at most, with its number (and repo) under it. */
function PullRequestCell({ pr }: { pr: PullRequestMinutes }) {
  const { showRepository } = useTableContext();
  const Icon = STATE_ICON[stateOf(pr)];
  return (
    <a
      href={pullRequestUrl(pr.repository, pr.number)}
      target="_blank"
      rel="noreferrer"
      title="Open the pull request on GitHub"
      className="group flex min-w-0 items-start gap-1.5"
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="grid min-w-0">
        {pr.title && (
          <span className="line-clamp-2 font-medium underline-offset-4 group-hover:underline">
            {pr.title}
          </span>
        )}
        <span className="truncate text-xs text-muted-foreground">
          #{pr.number}
          {showRepository && <span className="font-mono"> · {pr.repository}</span>}
        </span>
      </span>
    </a>
  );
}

const column = dataTableColumns<PullRequestMinutes>();
const columns = column.columns([
  column.accessor("number", {
    id: "number",
    header: "Pull request",
    sortFn: "basic",
    sortDescFirst: true,
    // Takes the room the numbers leave, so a long title wraps or truncates instead of widening
    // the table.
    meta: { className: "w-full max-w-0" },
    cell: ({ row: { original: pr } }) => <PullRequestCell pr={pr} />,
  }),
  column.accessor(dateOf, {
    id: "date",
    header: "Date",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, info: "When it merged, or opened if it hasn't merged." },
    cell: ({ row: { original: pr } }) => <span title={dateTitle(pr)}>{shortDate(dateOf(pr))}</span>,
  }),
  column.accessor("minutes", {
    header: "Minutes",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, className: "whitespace-nowrap" },
    cell: ({ row: { original: pr } }) => (
      <span className="flex items-center justify-end gap-2">
        <MinutesBar pr={pr} />
        <span className="grid">
          {minutesOf(pr.minutes)}
          {/* Phones leave out the spend column, so it shows here. */}
          <span className="text-xs text-muted-foreground sm:hidden">{money(pr.cost)}</span>
        </span>
      </span>
    ),
  }),
  column.accessor("rerunMinutes", {
    header: "Re-runs",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, hideOnPhone: true, info: "Minutes from re-run attempts of its runs." },
    cell: ({ getValue }) => (getValue() ? minutesOf(getValue()) : "–"),
  }),
  column.accessor("commits", {
    header: "Commits",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, hideOnPhone: true, info: "Commits that ran CI in the range." },
    cell: ({ getValue }) => <Count value={getValue()} />,
  }),
  column.accessor("cost", {
    header: "Est. spend",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, hideOnPhone: true },
    cell: ({ getValue }) => money(getValue()),
  }),
]);
