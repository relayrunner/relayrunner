// A Signals area and its signal cards, each a table of where the signal showed up.
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChevronRightIcon, type LucideIcon } from "lucide-react";
import { type MouseEvent, type ReactNode } from "react";
import { Count } from "@/components/count";
import { ExternalLink, LINK } from "@/components/run-sheet";
import { RunnerLink } from "@/components/runner-link";
import { PublicRepoMark } from "@/components/public-repo";
import { SECTION_HEADING } from "@/components/ui/data-table";
import { InfoTip } from "@/components/ui/info-tip";
import {
  PHONE_HIDDEN,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AREAS,
  type Signal,
  type SignalArea,
  type SignalId,
  type SignalRow,
  type SignalTrend,
  SIGNAL_COPY,
  type SignalsReport,
} from "@/lib/signals";
import { useSetSearch } from "@/lib/search-params";
import { money } from "@/lib/usage";
import { rangePhrase, resolveRange, type TimeRange, trendPhrase } from "@/lib/time-range";
import { shortDate } from "@/lib/time-zone";
import { cn, count, niceMax } from "@/lib/utils";
import { docsAnchor, type Search } from "@/features/signals/search";

/** Whether the page covers more than one repo; with one, rows leave the repo out. */
export function spansRepos(report: SignalsReport) {
  const repos = new Set([
    ...report.signals.flatMap((signal) => signal.rows.map((row) => row.repository)),
    ...report.breakdown.repository.rows.map((row) => row.name),
  ]);
  return repos.size > 1;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

// The filter's minutes per day, with the range before as a dashed line behind them.
export function Trend({ trend, range }: { trend: SignalTrend; range: TimeRange }) {
  const prior = trendPhrase(range);
  const now = sum(trend.minutes);
  const before = trend.previous ? sum(trend.previous) : null;
  let change: string;
  if (before === null) change = "Nothing earlier to compare with.";
  else if (before === 0) change = `None in ${prior}.`;
  else {
    const pct = Math.round(((now - before) / before) * 100);
    change =
      Math.abs(pct) < 5
        ? `About the same as ${prior}.`
        : `${Math.abs(pct)}% ${pct > 0 ? "more" : "less"} than ${prior}.`;
  }
  const width = 100;
  const height = 48;
  const top = niceMax(Math.max(...trend.minutes, ...(trend.previous ?? [])));
  const line = (values: number[]) =>
    values
      .map((value, index) => {
        const x = values.length > 1 ? (index / (values.length - 1)) * width : width / 2;
        return `${x.toFixed(2)},${(height - (value / top) * height).toFixed(2)}`;
      })
      .join(" ");
  const today = Date.now();
  const { from, to } = resolveRange(range, today);
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        <span className="font-medium">{count(now)} minutes</span>{" "}
        <span className="text-muted-foreground">{change}</span>
      </p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Minutes per day over ${rangePhrase(range)}`}
        className="h-14 w-full overflow-visible"
      >
        {trend.previous && (
          <polyline
            points={line(trend.previous)}
            fill="none"
            vectorEffect="non-scaling-stroke"
            strokeDasharray="3 3"
            className="stroke-muted-foreground/50"
            strokeWidth={1.25}
          />
        )}
        <polyline
          points={`0,${height} ${line(trend.minutes)} ${width},${height}`}
          className="fill-primary/10"
          stroke="none"
        />
        <polyline
          points={line(trend.minutes)}
          fill="none"
          vectorEffect="non-scaling-stroke"
          className="stroke-primary"
          strokeWidth={1.75}
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{shortDate(from)}</span>
        {trend.previous && (
          <span className="inline-flex items-center gap-1.5">
            <svg aria-hidden viewBox="0 0 16 2" className="h-0.5 w-4 overflow-visible">
              <line
                x1="0"
                y1="1"
                x2="16"
                y2="1"
                strokeDasharray="3 3"
                className="stroke-muted-foreground"
              />
            </svg>
            {prior.charAt(0).toUpperCase() + prior.slice(1)}
          </span>
        )}
        <span>{to === today ? "Today" : shortDate(to - 1)}</span>
      </div>
    </div>
  );
}

// A section's heading, with the signals or table under it indented past the icon.
export function Section({
  icon: Icon,
  title,
  question,
  aside,
  children,
}: {
  icon: LucideIcon;
  title: string;
  question: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-5 border-t pt-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2.5">
          <Icon aria-hidden className="size-5 self-center" />
          <h2 className="text-lg font-semibold">{title}</h2>
          <span className="text-muted-foreground">{question}</span>
        </div>
        {aside}
      </div>
      <div className="grid gap-6 sm:pl-7.5">{children}</div>
    </div>
  );
}

export function AreaSection({
  area,
  report,
  manyRepos,
}: {
  area: SignalArea;
  report: SignalsReport;
  manyRepos: boolean;
}) {
  const signals = report.signals.filter((signal) => signal.area === area);
  const shown = new Set(signals.map((signal) => signal.id));
  const quiet = (Object.keys(SIGNAL_COPY) as SignalId[]).filter(
    (id) => SIGNAL_COPY[id].area === area && !shown.has(id),
  );
  return (
    <Section
      {...AREAS[area]}
      aside={
        area === "cost" && (
          <span className="text-sm text-muted-foreground">
            {money(report.totals.cost)} across {count(report.totals.minutes)} minutes
          </span>
        )
      }
    >
      {signals.map((signal) => (
        <SignalCard key={signal.id} signal={signal} manyRepos={manyRepos} />
      ))}
      {quiet.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
          No sign of
          {quiet.map((id, index) => (
            <span key={id} className="inline-flex items-center gap-1">
              <span className="text-foreground">{SIGNAL_COPY[id].title}</span>
              <SignalInfo id={id} />
              {index < quiet.length - 1 && ","}
            </span>
          ))}
        </p>
      )}
    </Section>
  );
}

// The ⓘ beside a signal's title: what it means, and where the docs explain how it's worked out.
function SignalInfo({ id }: { id: SignalId }) {
  const { title, about } = SIGNAL_COPY[id];
  return (
    <InfoTip label={title}>
      {about}
      <ExternalLink href={docsAnchor(title)}>How it's worked out</ExternalLink>
    </InfoTip>
  );
}

// Where to go next for a signal: the fix in RelayRunner first, GitHub's docs second.
export function SignalLinks({ id }: { id: SignalId }) {
  const { action, docs } = SIGNAL_COPY[id];
  if (!action && !docs) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {action &&
        (action.href.startsWith("/") ? (
          <Link to={action.href} className={LINK}>
            {action.label}
          </Link>
        ) : (
          <a href={action.href} className={LINK}>
            {action.label}
          </a>
        ))}
      {docs && (
        <a
          href={docs}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          Learn more in the GitHub docs
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </a>
      )}
    </div>
  );
}

/** Rows split by repo, in the order each repo first shows up (the most time first). */
function byRepo(rows: SignalRow[]) {
  const groups = new Map<string, SignalRow[]>();
  for (const row of rows) groups.set(row.repository, [...(groups.get(row.repository) ?? []), row]);
  return [...groups];
}

function SignalCard({ signal, manyRepos }: { signal: Signal; manyRepos: boolean }) {
  const copy = SIGNAL_COPY[signal.id];
  const navigate = useNavigate();
  const setSearch = useSetSearch<Search>();
  // A panel, so the back button closes it.
  const openRuns = (row: SignalRow) =>
    void navigate({
      to: ".",
      search: ((prev: Search) => ({
        ...prev,
        signal: signal.id,
        in: row.repository,
        subject: row.subject,
      })) as never,
      resetScroll: false,
    });
  // Signals that cost time but no money keep the column, empty, so columns line up down the page.
  const spend = copy.spend !== false;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-[15px] font-medium">
          {copy.title}
          <SignalInfo id={signal.id} />
        </h3>
        <div className="ml-auto">
          <SignalLinks id={signal.id} />
        </div>
      </div>
      {/* Fixed columns, so every signal's numbers line up down the page. Phones leave out spend. */}
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>{copy.subject}</TableHead>
            <TableHead className={cn(FIGURE_HEAD, "sm:w-36")}>{copy.count}</TableHead>
            <TableHead className={cn(FIGURE_HEAD, "sm:w-36")}>{copy.minutes}</TableHead>
            <TableHead className={cn(FIGURE_HEAD, PHONE_HIDDEN)}>{spend && "Spend"}</TableHead>
            <TableHead className="w-9">
              <span className="sr-only">Runs</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        {/* With more than one repo on the page, each repo heads its own rows; its name narrows
            the page to it. */}
        {byRepo(signal.rows).map(([repository, rows]) => (
          <TableBody key={repository}>
            {manyRepos && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className={SECTION_HEADING}>
                  <button
                    type="button"
                    onClick={() => setSearch({ repo: repository })}
                    className="max-w-full truncate text-left hover:text-foreground hover:underline"
                  >
                    {repository}
                  </button>
                  <PublicRepoMark repository={repository} />
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow
                key={row.subject}
                onClick={(event) => unlessLink(event, () => openRuns(row))}
                className="cursor-pointer"
              >
                <TableCell className="break-words sm:truncate">
                  <SubjectName row={row} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Count value={row.count} />
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  <Count value={row.minutes} />
                </TableCell>
                <TableCell className={cn("text-right tabular-nums", PHONE_HIDDEN)}>
                  {spend && money(row.cost)}
                </TableCell>
                <TableCell className="text-right">
                  <button
                    type="button"
                    aria-label={`Show the runs behind ${row.repository} / ${row.subject}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRightIcon aria-hidden className="size-4" />
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        ))}
      </Table>
    </div>
  );
}

/** A figure column's header: narrow on phones, where a long label wraps. */
export const FIGURE_HEAD = "w-24 text-right whitespace-normal sm:whitespace-nowrap";

export const workflowUrl = (repository: string, path: string) =>
  `https://github.com/${repository}/blob/HEAD/${path}`;

// A row's click, unless it was on a link inside it (a runner's name opens its own panel).
function unlessLink(event: MouseEvent, action: () => void) {
  if (!(event.target as Element).closest("a")) action();
}

// A runner row's name opens the runner's panel; the row opens its runs. The repo heads the rows.
function SubjectName({ row }: { row: SignalRow }) {
  if (!row.runnerKey) return row.subject;
  return (
    <RunnerLink
      runner={{ key: row.runnerKey, label: row.subject }}
      className="inline-flex max-w-full items-center gap-2"
      markClassName="size-4"
    >
      <span className="min-w-0 sm:truncate">{row.subject}</span>
    </RunnerLink>
  );
}

// "acme/web / CI", with the repo quieter.
export function SubjectText({ repository, name }: { repository: string; name: string }) {
  return (
    <>
      <span className="text-muted-foreground">{repository} / </span>
      {name}
    </>
  );
}

// "acme/web / CI", linking to the workflow file on GitHub when the run said which file it was.
export function WorkflowName({
  repository,
  name,
  path,
}: {
  repository: string;
  name: string;
  path: string | null;
}) {
  const text = <SubjectText repository={repository} name={name} />;
  if (!path) return text;
  return (
    <a
      href={workflowUrl(repository, path)}
      target="_blank"
      rel="noreferrer"
      className="hover:underline"
    >
      {text}
    </a>
  );
}
