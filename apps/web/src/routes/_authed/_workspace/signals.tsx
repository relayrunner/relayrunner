import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChartBarBigIcon,
  ChevronRightIcon,
  type LucideIcon,
  XIcon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { CommitBy } from "@/components/commit";
import { Count } from "@/components/count";
import { PageHeader } from "@/components/page-header";
import { OptionPicker, TimeRangePicker } from "@/components/range-picker";
import { ExternalLink, LINK, RunLink } from "@/components/run-sheet";
import { RunnerLink } from "@/components/runner-link";
import { DOCS_URL } from "@/components/site-footer";
import { StatusIcon } from "@/components/status-icon";
import { SECTION_HEADING } from "@/components/ui/data-table";
import { InfoTip } from "@/components/ui/info-tip";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  PHONE_HIDDEN,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { timeAgo } from "@/lib/activity";
import {
  AREAS,
  BREAKDOWN_VIEWS,
  folderName,
  type BreakdownBy,
  type BreakdownRow,
  FILTER_KEYS,
  type FilterKey,
  getSignalRuns,
  getSignals,
  isFiltered,
  rowFilter,
  type Signal,
  type SignalArea,
  type SignalFilter,
  type SignalId,
  type SignalRow,
  type SignalRowRef,
  type SignalRun,
  type SignalRunsReport,
  type SignalTrend,
  SIGNAL_COPY,
  type SignalsReport,
  triggerName,
} from "@/lib/signals";
import {
  optionParam,
  rangeSearch,
  textParam,
  unlessDefault,
  useRangeReport,
  useSetSearch,
} from "@/lib/search-params";
import { money } from "@/lib/usage";
import { plural } from "@/lib/job-times";
import {
  dayPreset,
  type RangeOptions,
  rangeDays,
  rangePhrase,
  resolveRange,
  type TimeRange,
  timeRangeParam,
  trendPhrase,
} from "@/lib/time-range";
import { shortDate } from "@/lib/time-zone";
import { cn, count, elapsed, niceMax } from "@/lib/utils";

const RANGES: RangeOptions = {
  presets: ["7d", "14d", "30d", "90d", "week", "lastweek", "month", "lastmonth"],
};
// A filtered page works from single jobs over the last 30 days (FILTERED_MAX_DAYS in lib/signals),
// not as far back as the daily rollup.
const FILTERED_RANGES: RangeOptions = {
  presets: ["7d", "14d", "30d", "week", "lastweek", "month"],
};
const DEFAULT_RANGE: TimeRange = "30d";
const ranges = rangeSearch(RANGES, DEFAULT_RANGE);

// The range and filter a report is for.
const keyOf = (range: TimeRange, filter: SignalFilter) =>
  JSON.stringify([range, ...FILTER_KEYS.map((key) => filter[key] ?? "")]);

function load(range: TimeRange, filter: SignalFilter): Promise<SignalsReport> {
  return getSignals(range, filter);
}

const BREAKDOWNS = BREAKDOWN_VIEWS.map((option) => option.value);
const SIGNAL_IDS = Object.keys(SIGNAL_COPY) as SignalId[];
// `by` is how the Breakdown splits jobs; the filter's values narrow the page; `signal`, `in` and
// `subject` name the signal row whose runs are open in the panel.
type Search = { range?: TimeRange; by?: BreakdownBy } & SignalFilter & {
    signal?: SignalId;
    in?: string;
    subject?: string;
  };
const validateSearch = (search: Record<string, unknown>): Search => {
  const signal = SIGNAL_IDS.includes(search.signal as SignalId)
    ? (search.signal as SignalId)
    : undefined;
  const row = signal && textParam(search.in) && textParam(search.subject);
  return {
    ...ranges.validateSearch(search),
    by: optionParam(search.by, BREAKDOWNS),
    ...Object.fromEntries(FILTER_KEYS.map((key) => [key, textParam(search[key])])),
    signal: row ? signal : undefined,
    in: row ? textParam(search.in) : undefined,
    subject: row ? textParam(search.subject) : undefined,
  };
};
const filterOf = (search: Search): SignalFilter =>
  Object.fromEntries(FILTER_KEYS.map((key) => [key, search[key]]));
/** The page's range: a filtered page's is at most 30 days. */
function rangeOf(search: Search) {
  const range = ranges.rangeOf(search);
  if (!isFiltered(search)) return range;
  return timeRangeParam(range, FILTERED_RANGES, DEFAULT_RANGE) ?? DEFAULT_RANGE;
}
// Every filter key, cleared.
const NO_FILTER = Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined])) as SignalFilter;

const SIGNALS_DOCS = `${DOCS_URL}/dashboard/signals`;
// A signal's section on the docs page: Starlight's heading id for its title.
const docsAnchor = (title: string) =>
  `${SIGNALS_DOCS}#${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export const Route = createFileRoute("/_authed/_workspace/signals")({
  validateSearch,
  loader: ({ location }) => {
    const search = validateSearch(location.search);
    return load(rangeOf(search), filterOf(search));
  },
  // A new range or filter loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: SignalsPage,
});

function SignalsPage() {
  const search = Route.useSearch();
  const range = rangeOf(search);
  const filter = filterOf(search);
  const filtered = isFiltered(filter);
  const setSearch = useSetSearch<Search>();
  const key = keyOf(range, filter);
  const report = useRangeReport(Route.useLoaderData(), key, () => load(range, filter));
  const manyRepos = spansRepos(report);

  function chooseRange(next: TimeRange) {
    setSearch(ranges.toSearch(next));
  }

  return (
    <section>
      <PageHeader title="Signals">
        What makes your CI slow, costly or busier than it needs to be, and where. Updated every
        hour. <ExternalLink href={SIGNALS_DOCS}>How signals work</ExternalLink>
      </PageHeader>
      <div className="grid max-w-4xl gap-10">
        <div className="grid gap-4">
          <TimeRangePicker
            {...(filtered ? FILTERED_RANGES : RANGES)}
            value={range}
            onChange={chooseRange}
          />
          {filtered && <FilterBar filter={filter} report={report} range={range} />}
        </div>
        {report.totals.jobs === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            {filtered
              ? "No finished jobs match this filter in this range."
              : "No finished jobs in this range yet. Signals show up within an hour of jobs running in a connected repo."}
          </p>
        ) : (
          <>
            {/* Every area shows, with the signals that didn't show up named under it, so the page
                says what it looks for and not only what it found. */}
            {(Object.keys(AREAS) as SignalArea[]).map((area) => (
              <AreaSection key={area} area={area} report={report} manyRepos={manyRepos} />
            ))}
            <BreakdownSection report={report} manyRepos={manyRepos} />
          </>
        )}
      </div>
      {search.signal && search.in && search.subject && (
        <RunsPanel
          key={`${search.signal}:${search.in}:${search.subject}:${key}`}
          row={{ signal: search.signal, repository: search.in, subject: search.subject }}
          listed={report.signals
            .find((signal) => signal.id === search.signal)
            ?.rows.find((row) => row.repository === search.in && row.subject === search.subject)}
          range={range}
          filter={filter}
        />
      )}
    </section>
  );
}

/** Whether the page covers more than one repo; with one, rows leave the repo out. */
function spansRepos(report: SignalsReport) {
  const repos = new Set([
    ...report.signals.flatMap((signal) => signal.rows.map((row) => row.repository)),
    ...report.breakdown.repository.rows.map((row) => row.name),
  ]);
  return repos.size > 1;
}

const FILTER_LABELS: Record<FilterKey, string> = {
  person: "Person",
  repo: "Repository",
  workflow: "Workflow",
  branch: "Branch",
  trigger: "Trigger",
  path: "Folder",
};

// What the page is narrowed to, each value with a button to drop it, and the filter's trend.
function FilterBar({
  filter,
  report,
  range,
}: {
  filter: SignalFilter;
  report: SignalsReport;
  range: TimeRange;
}) {
  const setSearch = useSetSearch<Search>();
  // A workflow or folder shows with its repo, and goes with it, so the repo shows on its own only
  // without one.
  const shown = FILTER_KEYS.filter(
    (key) => filter[key] && !(key === "repo" && (filter.workflow || filter.path)),
  );
  const parts = shown.map((key) => {
    const value = filter[key]!;
    if (key === "workflow") {
      const path = report.breakdown.workflow.rows[0]?.workflowPath ?? null;
      return {
        label: FILTER_LABELS[key],
        value: <WorkflowName repository={filter.repo ?? ""} name={value} path={path} />,
        clear: { workflow: undefined, repo: filter.path ? filter.repo : undefined },
      };
    }
    if (key === "path") {
      return {
        label: FILTER_LABELS[key],
        value: <SubjectText repository={filter.repo ?? ""} name={folderName(value)} />,
        clear: { path: undefined, repo: filter.workflow ? filter.repo : undefined },
      };
    }
    return {
      label: FILTER_LABELS[key],
      value: key === "trigger" ? triggerName(value) : value,
      clear: { [key]: undefined },
    };
  });

  return (
    <div className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {parts.map(({ label, value, clear }) => (
          <span key={label} className="inline-flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-medium">{value}</span>
            <button
              type="button"
              aria-label={`Remove the ${label.toLowerCase()} filter`}
              onClick={() => setSearch(clear)}
              className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </span>
        ))}
        {parts.length > 1 && (
          <button
            type="button"
            onClick={() => setSearch(NO_FILTER)}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            Clear all
          </button>
        )}
      </div>
      {report.trend && <Trend trend={report.trend} range={range} />}
    </div>
  );
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

// The filter's minutes per day, with the range before as a dashed line behind them.
function Trend({ trend, range }: { trend: SignalTrend; range: TimeRange }) {
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
function Section({
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

function AreaSection({
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
function SignalLinks({ id }: { id: SignalId }) {
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
const FIGURE_HEAD = "w-24 text-right whitespace-normal sm:whitespace-nowrap";

const workflowUrl = (repository: string, path: string) =>
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
function SubjectText({ repository, name }: { repository: string; name: string }) {
  return (
    <>
      <span className="text-muted-foreground">{repository} / </span>
      {name}
    </>
  );
}

// "acme/web / CI", linking to the workflow file on GitHub when the run said which file it was.
function WorkflowName({
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

// Every counted job split one way at a time, with each row's share of all job minutes (left out on
// phones, where the table scrolls like the signals above).
function BreakdownSection({ report, manyRepos }: { report: SignalsReport; manyRepos: boolean }) {
  const by = Route.useSearch({ select: (search) => search.by ?? BREAKDOWNS[0]! });
  const setSearch = useSetSearch<Search>();
  const setBy = (next: BreakdownBy) => setSearch({ by: unlessDefault(next, BREAKDOWNS[0]) });
  const { rows, other } = report.breakdown[by];
  const view = BREAKDOWN_VIEWS.find((option) => option.value === by)!;
  const total = report.totals.minutes;
  return (
    <Section
      icon={ChartBarBigIcon}
      title="Breakdown"
      question="Who and what uses your CI"
      aside={
        <OptionPicker label="Break down by" options={BREAKDOWN_VIEWS} value={by} onChange={setBy} />
      }
    >
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>{view.label}</TableHead>
            <TableHead className="hidden w-44 sm:table-cell">Share of minutes</TableHead>
            <TableHead className={cn("w-24 text-right", PHONE_HIDDEN)}>Runs</TableHead>
            <TableHead className={cn(FIGURE_HEAD, "sm:w-24")}>Minutes</TableHead>
            <TableHead className={cn(FIGURE_HEAD, "sm:w-28")}>Spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <BreakdownLine
              key={`${row.repository}:${row.name}`}
              name={<BreakdownName by={by} row={row} manyRepos={manyRepos} />}
              sums={row}
              total={total}
              onSelect={() => setSearch(rowFilter(by, row))}
            />
          ))}
          {other && (
            <BreakdownLine
              name={<span className="text-muted-foreground">Everything else</span>}
              sums={other}
              total={total}
            />
          )}
        </TableBody>
      </Table>
      {by === "path" && (
        <p className="text-sm text-muted-foreground">
          Pull request runs only. A run counts under every folder its pull request changed.
        </p>
      )}
    </Section>
  );
}

// A row with `onSelect` narrows the page to it; its name is the button, the whole row the target.
function BreakdownLine({
  name,
  sums,
  total,
  onSelect,
}: {
  name: ReactNode;
  sums: { runs: number; minutes: number; cost: number };
  total: number;
  onSelect?: () => void;
}) {
  const share = total ? sums.minutes / total : 0;
  return (
    <TableRow onClick={onSelect} className={cn(onSelect && "cursor-pointer")}>
      <TableCell className="truncate">
        {onSelect ? (
          <button type="button" className="max-w-full truncate text-left hover:underline">
            {name}
          </button>
        ) : (
          name
        )}
      </TableCell>
      <TableCell className={PHONE_HIDDEN}>
        <div className="flex items-center gap-2">
          <div aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised-2">
            <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
          </div>
          <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">
            {Math.round(share * 100)}%
          </span>
        </div>
      </TableCell>
      <TableCell className={cn("text-right tabular-nums", PHONE_HIDDEN)}>
        <Count value={sums.runs} />
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        <Count value={sums.minutes} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{money(sums.cost)}</TableCell>
    </TableRow>
  );
}

// Workflows and folders show their repo only when the page covers more than one.
function BreakdownName({
  by,
  row,
  manyRepos,
}: {
  by: BreakdownBy;
  row: BreakdownRow;
  manyRepos: boolean;
}) {
  if (by === "workflow" || by === "path") {
    const name = by === "path" ? folderName(row.name) : row.name;
    return manyRepos && row.repository ? (
      <SubjectText repository={row.repository} name={name} />
    ) : (
      name
    );
  }
  if (by === "trigger") return triggerName(row.name);
  return row.name;
}

// Signal time for one run: seconds under a minute, else whole minutes (CI time never reads in hours).
const runTime = (ms: number) => (ms < 60_000 ? elapsed(ms) : `${count(Math.round(ms / 60_000))}m`);

// The runs behind one signal row, newest first, each opening in History's panel.
// Keyed on the row, range and filter, so it loads once.
function RunsPanel({
  row,
  listed,
  range,
  filter,
}: {
  row: SignalRowRef;
  /** The row as the page lists it, when it does. */
  listed: SignalRow | undefined;
  range: TimeRange;
  filter: SignalFilter;
}) {
  const setSearch = useSetSearch<Search>();
  const close = () => setSearch({ signal: undefined, in: undefined, subject: undefined });
  const [found, setFound] = useState<SignalRunsReport | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    const request = getSignalRuns(row, range, filter);
    request.then(
      (next) => live && setFound(next),
      () => live && setFound("failed"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the row
  }, []);

  const copy = SIGNAL_COPY[row.signal];
  // Runs come from single jobs, so a longer range lists only its last 30 days.
  const span =
    found && found !== "failed" && found.days < rangeDays(range)
      ? rangePhrase(dayPreset(found.days))
      : rangePhrase(range);

  let body: ReactNode;
  if (found === "failed")
    body = (
      <p className="text-sm text-muted-foreground">
        Couldn't load these runs. Try again in a moment.
      </p>
    );
  else if (!found)
    body = (
      <div aria-busy aria-label="Loading runs" className="grid gap-3">
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} className="h-9 rounded-sm bg-secondary/60" />
        ))}
      </div>
    );
  else if (!found.runs.length)
    body = <p className="text-sm text-muted-foreground">No runs behind this row in {span}.</p>;
  else
    body = (
      <div className="grid gap-2">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {plural(found.total, "run")} in {span}
          </span>
          <span>{copy.minutes}</span>
        </div>
        <ul className="divide-y rounded-lg border">
          {found.runs.map((run) => (
            <RunItem key={`${run.runId}-${run.runAttempt}`} run={run} />
          ))}
        </ul>
        {found.total > found.runs.length && (
          <p className="text-xs text-muted-foreground">
            The newest {found.runs.length} of {count(found.total)}.
          </p>
        )}
      </div>
    );

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent aria-describedby={undefined} widthKey="signal-runs-width">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-5 py-5 sm:px-6">
          <header className="grid gap-1 pr-8">
            <SheetTitle>{copy.title}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 truncate">
                <SubjectText repository={row.repository} name={row.subject} />
              </span>
              {listed?.workflowPath && (
                <ExternalLink href={workflowUrl(row.repository, listed.workflowPath)}>
                  Workflow file
                </ExternalLink>
              )}
              {listed?.runnerKey && (
                <RunnerLink
                  runner={{ key: listed.runnerKey, label: "Runner" }}
                  className="inline-flex items-center gap-1.5"
                  markClassName="size-3.5"
                />
              )}
            </SheetDescription>
          </header>
          {/* What the signal means, so the runs below read in context. */}
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">{copy.about}</p>
            <SignalLinks id={row.signal} />
          </div>
          {body}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RunItem({ run }: { run: SignalRun }) {
  return (
    <li>
      <RunLink
        run={run}
        job={run.jobId ?? undefined}
        className="group flex items-start gap-3 px-3 py-2.5 hover:bg-secondary/30"
      >
        <StatusIcon
          status="completed"
          conclusion={run.conclusion ?? "unknown"}
          className="mt-0.5 size-4"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm underline-offset-4 group-hover:underline">
            {run.title ?? run.workflow ?? `Run ${run.runId}`}
          </span>
          <span className="flex flex-wrap items-center gap-x-2.5 text-xs text-muted-foreground">
            <span>
              {[run.event && triggerName(run.event), run.branch].filter(Boolean).join(" on ")}
            </span>
            <CommitBy actor={run.actor} sha={run.sha} />
            {run.startedAt !== null && <span>{timeAgo(run.startedAt)}</span>}
          </span>
        </span>
        <span className="text-sm font-medium tabular-nums">{runTime(run.runMs)}</span>
      </RunLink>
    </li>
  );
}
