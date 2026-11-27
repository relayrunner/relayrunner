import { GitPullRequestIcon } from "lucide-react";
import { useMemo } from "react";
import { Count } from "@/components/count";
import { StatTile } from "@/components/stat-tile";
import { DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { TimeRangePicker } from "@/components/range-picker";
import { RepoSelect, repositoriesOf } from "@/components/repo-select";
import { minutesText } from "@/lib/job-times";
import {
  PULL_REQUEST_RANGES,
  type PullRequestMinutes,
  type PullRequestReport,
  summarize,
} from "@/lib/pull-requests";
import { pullRequestUrl } from "@/lib/runs";
import type { ExportColumn } from "@/lib/table-export";
import type { TimeRange } from "@/lib/time-range";
import { money } from "@/lib/usage";
import { percent } from "@/lib/utils";

const minutesOf = (minutes: number) => minutesText(minutes * 60_000);
const min = (minutes: number) => `${minutesOf(minutes)} min`;

/**
 * Usage › Pull requests: CI minutes per pull request across its pushes and re-runs, the typical
 * pull request over the range, and each one's estimated spend. `repository` narrows it all to one
 * repo ("all" for every one), worked out here since the report holds the whole range.
 */
export function PullRequestUsage({
  report,
  range,
  onRange,
  repository,
  onRepository,
}: {
  report: PullRequestReport;
  range: TimeRange;
  onRange: (range: TimeRange) => void;
  repository: string;
  onRepository: (repository: string) => void;
}) {
  const repositories = useMemo(
    () => repositoriesOf([...report.pullRequests, ...report.outside]),
    [report],
  );
  const showRepository = repositories.length > 1 && repository === "all";
  const { pullRequests, summary } = useMemo(() => {
    const keep = (row: { repository: string }) =>
      repository === "all" || row.repository === repository;
    const pullRequests = report.pullRequests.filter(keep);
    return { pullRequests, summary: summarize(pullRequests, report.outside.filter(keep)) };
  }, [report, repository]);

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

          <DataTable
            columns={showRepository ? columns : withoutRepository}
            data={pullRequests}
            getRowId={(pr) => `${pr.repository}#${pr.number}`}
            initialSorting={[{ id: "minutes", desc: true }]}
            exportAs={{
              name: repository === "all" ? "pull-requests" : `pull-requests-${repository}`,
              columns: EXPORT_COLUMNS,
            }}
          />
        </>
      )}

      <p className="max-w-[62ch] text-sm text-muted-foreground">
        Minutes are the time each pull request's jobs ran, over every push and re-run in the range.
        Pushes to a branch before its pull request opened count toward it. Typical is the median
        pull request. Spend uses the same per-minute estimates as the Overview, after GitHub rounds
        each job up to a whole minute.
      </p>
    </div>
  );
}

// An export names each pull request in full, with its link, and keeps spend in USD.
const EXPORT_COLUMNS: ExportColumn<PullRequestMinutes>[] = [
  { header: "Repo", value: (pr) => pr.repository },
  { header: "Number", value: (pr) => pr.number },
  { header: "Title", value: (pr) => pr.title },
  { header: "URL", value: (pr) => pullRequestUrl(pr.repository, pr.number) },
  { header: "Minutes", value: (pr) => pr.minutes },
  { header: "Re-run minutes", value: (pr) => pr.rerunMinutes },
  { header: "Commits", value: (pr) => pr.commits },
  { header: "Est. spend (USD)", value: (pr) => pr.cost },
];

const column = dataTableColumns<PullRequestMinutes>();
const columns = column.columns([
  column.accessor((pr) => pr.title ?? `#${pr.number}`, {
    id: "pullRequest",
    header: "Pull request",
    sortFn: "text",
    // Takes the room the numbers leave, so a long title truncates instead of widening the table.
    meta: { className: "w-full max-w-0" },
    cell: ({ row: { original: pr } }) => (
      <a
        href={pullRequestUrl(pr.repository, pr.number)}
        target="_blank"
        rel="noreferrer"
        title="Open the pull request on GitHub"
        className="flex min-w-0 items-center gap-1.5 underline-offset-4 hover:underline"
      >
        <GitPullRequestIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {pr.title && <span className="truncate font-medium">{pr.title}</span>}
        <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
      </a>
    ),
  }),
  column.accessor("repository", {
    id: "repository",
    header: "Repo",
    sortFn: "text",
    meta: { className: "font-mono text-muted-foreground", hideOnPhone: true },
  }),
  column.accessor("minutes", {
    header: "Minutes",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, className: "whitespace-nowrap" },
    cell: ({ getValue }) => minutesOf(getValue()),
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
    meta: NUM,
    cell: ({ getValue }) => money(getValue()),
  }),
]);
const withoutRepository = columns.filter((c) => c.id !== "repository");
