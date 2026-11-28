import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon } from "lucide-react";
import { useMemo } from "react";
import { TipRow } from "@/components/chart-parts";
import { Count } from "@/components/count";
import { Histogram } from "@/components/histogram";
import { StatTile } from "@/components/stat-tile";
import { createCellContext, DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { TimeRangePicker } from "@/components/range-picker";
import { RepoSelect, repositoriesOf } from "@/components/repo-select";
import { minutesText } from "@/lib/job-times";
import {
  bucketPosition,
  dateOf,
  minuteBuckets,
  PULL_REQUEST_RANGES,
  type PullRequestMinutes,
  type PullRequestReport,
  stateOf,
  summarize,
} from "@/lib/pull-requests";
import { pullRequestUrl } from "@/lib/runs";
import { type Sort, sortOf, sortParam } from "@/lib/search-params";
import { isoTime, type ExportColumn } from "@/lib/table-export";
import type { TimeRange } from "@/lib/time-range";
import { formatDate, shortDate } from "@/lib/time-zone";
import { money } from "@/lib/usage";
import { percent } from "@/lib/utils";

const minutesOf = (minutes: number) => minutesText(minutes * 60_000);
const min = (minutes: number) => `${minutesOf(minutes)} min`;

// The table's columns `?sort=` can name, and its sort without one: the most minutes first.
const SORTABLE = ["number", "date", "minutes", "rerunMinutes", "commits", "cost"];
const DEFAULT_SORT: Sort = { id: "minutes", desc: true };

/** The table's sort from its `?sort=`. */
export const pullRequestSortOf = (value: unknown) => sortOf(value, SORTABLE);

/**
 * Usage › Pull requests: CI minutes per pull request across its pushes and re-runs, the typical
 * pull request over the range, and each one's estimated spend. `repository` narrows it all to one
 * repo ("all" for every one), worked out here since the report holds the whole range. `sort` is
 * the table's, kept in the URL (undefined at the default, the most minutes first).
 */
export function PullRequestUsage({
  report,
  range,
  onRange,
  repository,
  onRepository,
  sort = DEFAULT_SORT,
  onSort,
}: {
  report: PullRequestReport;
  range: TimeRange;
  onRange: (range: TimeRange) => void;
  repository: string;
  onRepository: (repository: string) => void;
  sort?: Sort;
  onSort: (sort: string | undefined) => void;
}) {
  const repositories = useMemo(
    () => repositoriesOf([...report.pullRequests, ...report.outside]),
    [report],
  );
  const showRepository = repositories.length > 1 && repository === "all";
  const { pullRequests, summary, table } = useMemo(() => {
    const keep = (row: { repository: string }) =>
      repository === "all" || row.repository === repository;
    const pullRequests = report.pullRequests.filter(keep);
    return {
      pullRequests,
      summary: summarize(pullRequests, report.outside.filter(keep)),
      table: { most: Math.max(0, ...pullRequests.map((pr) => pr.minutes)), showRepository },
    };
  }, [report, repository, showRepository]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <TimeRangePicker {...PULL_REQUEST_RANGES} value={range} onChange={onRange} />
        <RepoSelect value={repository} repositories={repositories} onChange={onRepository} />
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

          <Spread pullRequests={pullRequests} summary={summary} />

          <TableContext value={table}>
            <DataTable
              columns={columns}
              data={pullRequests}
              getRowId={(pr) => `${pr.repository}#${pr.number}`}
              sorting={[sort]}
              // Sorting a column a third time goes back to the default, rather than to no sort.
              onSortingChange={([next = DEFAULT_SORT]) =>
                onSort(next.id === DEFAULT_SORT.id && next.desc ? undefined : sortParam(next))
              }
              exportAs={{
                name: repository === "all" ? "pull-requests" : `pull-requests-${repository}`,
                columns: EXPORT_COLUMNS,
              }}
            />
          </TableContext>
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
function Spread({
  pullRequests,
  summary,
}: {
  pullRequests: PullRequestMinutes[];
  summary: ReturnType<typeof summarize>;
}) {
  if (pullRequests.length < 5) return null;
  const buckets = minuteBuckets(pullRequests.map((pr) => pr.minutes));
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

const STATE_ICON = {
  open: GitPullRequestIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
};

// What the Date column shows for a pull request, for its hover text.
function dateTitle(pr: PullRequestMinutes) {
  if (pr.mergedAt !== null) return `Merged ${formatDate(pr.mergedAt)}`;
  if (pr.openedAt !== null) return `Opened ${formatDate(pr.openedAt)}`;
  return `First CI run ${formatDate(pr.firstRunAt)}`;
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
