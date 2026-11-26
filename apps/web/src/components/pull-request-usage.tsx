import { GitPullRequestIcon } from "lucide-react";
import { useMemo } from "react";
import { Count } from "@/components/count";
import { StatTile } from "@/components/stat-tile";
import { DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { minutesText } from "@/lib/job-times";
import { type PullRequestMinutes, type PullRequestReport, summarize } from "@/lib/pull-requests";
import { pullRequestUrl } from "@/lib/runs";
import { money } from "@/lib/usage";
import { percent } from "@/lib/utils";

const DAY_MS = 86_400_000;
const min = (minutes: number) => `${minutesText(minutes * 60_000)} min`;

/**
 * Usage › Pull requests: CI minutes per pull request across its pushes and re-runs, the typical
 * pull request over the range, and each one's estimated spend. `repository` narrows it all to one
 * repo ("all" for every one), worked out here since the report holds the whole range.
 */
export function PullRequestUsage({
  report,
  from,
  repository,
  onRepository,
  picker,
}: {
  report: PullRequestReport;
  /** Where the range asked for starts, epoch ms, to say when the report starts later. */
  from: number;
  repository: string;
  onRepository: (repository: string) => void;
  picker: React.ReactNode;
}) {
  const repositories = useMemo(
    () =>
      [...new Set([...report.pullRequests, ...report.outside].map((row) => row.repository))].sort(),
    [report],
  );
  const showRepository = repositories.length > 1 && repository === "all";
  const { pullRequests, summary } = useMemo(() => {
    const keep = (row: { repository: string }) =>
      repository === "all" || row.repository === repository;
    const pullRequests = report.pullRequests.filter(keep);
    return { pullRequests, summary: summarize(pullRequests, report.outside.filter(keep)) };
  }, [report, repository]);
  // A day of slack, so a calendar month starting at the reader's midnight doesn't count.
  const clipped = report.from - from > DAY_MS;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {picker}
        {repositories.length > 1 && (
          <Select value={repository} onValueChange={onRepository}>
            <SelectTrigger size="sm" aria-label="Repo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All repos</SelectItem>
              {repositories.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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
              detail={`average ${money(summary.cost.average)}, ${money(summary.totalCost)} in all`}
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
          />
        </>
      )}

      <p className="max-w-[62ch] text-sm text-muted-foreground">
        Minutes are the time each pull request's jobs ran, over every push and re-run in the range.
        Pushes to a branch before its pull request opened count toward it. Typical is the median
        pull request. Spend uses the same per-minute estimates as the Overview, after GitHub rounds
        each job up to a whole minute.
        {clipped &&
          ` Pull requests cover the last ${Math.round((report.to - report.from) / DAY_MS)} days, as far back as jobs are kept.`}
      </p>
    </div>
  );
}

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
    cell: ({ getValue }) => minutesText(getValue() * 60_000),
  }),
  column.accessor("rerunMinutes", {
    header: "Re-runs",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, hideOnPhone: true, info: "Minutes from re-run attempts of its runs." },
    cell: ({ getValue }) => (getValue() ? minutesText(getValue() * 60_000) : "–"),
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
