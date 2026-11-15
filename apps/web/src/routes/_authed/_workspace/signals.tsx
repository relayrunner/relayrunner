import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChartBarBigIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Count } from "@/components/count";
import { PageHeader } from "@/components/page-header";
import { OptionPicker, RangePicker } from "@/components/range-picker";
import { ExternalLink, LINK } from "@/components/run-sheet";
import { RunnerLink } from "@/components/runner-link";
import { DOCS_URL } from "@/components/site-footer";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { authDisabled } from "@/lib/auth-client";
import {
  AREAS,
  BREAKDOWN_VIEWS,
  type BreakdownBy,
  type BreakdownRow,
  getSignals,
  type Signal,
  type SignalArea,
  type SignalId,
  type SignalRow,
  SIGNAL_COPY,
  type SignalsReport,
  sampleSignals,
  triggerName,
} from "@/lib/signals";
import {
  optionParam,
  rangeParam,
  unlessDefault,
  useRangeReport,
  useSetSearch,
} from "@/lib/search-params";
import { money } from "@/lib/usage";
import { count } from "@/lib/utils";

const RANGES = [7, 30, 90] as const;

function load(days: number): Promise<SignalsReport> {
  return authDisabled ? Promise.resolve(sampleSignals(days)) : getSignals(days);
}

const DEFAULT_DAYS = 30;
const BREAKDOWNS = BREAKDOWN_VIEWS.map((option) => option.value);
// `by` is how the Breakdown splits jobs.
type Search = { days?: number; by?: BreakdownBy };
const validateSearch = (search: Record<string, unknown>): Search => ({
  days: rangeParam(search.days, RANGES, DEFAULT_DAYS),
  by: optionParam(search.by, BREAKDOWNS),
});
const daysOf = (search: Search) => search.days ?? DEFAULT_DAYS;

const SIGNALS_DOCS = `${DOCS_URL}/dashboard/signals`;
// A signal's section on the docs page: Starlight's heading id for its title.
const docsAnchor = (title: string) =>
  `${SIGNALS_DOCS}#${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export const Route = createFileRoute("/_authed/_workspace/signals")({
  validateSearch,
  loader: ({ location }) => load(daysOf(validateSearch(location.search))),
  // A new range loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: SignalsPage,
});

function SignalsPage() {
  const days = daysOf(Route.useSearch());
  const setSearch = useSetSearch<Search>();
  const report = useRangeReport(Route.useLoaderData(), days, load);

  function chooseRange(next: number) {
    setSearch({ days: unlessDefault(next, DEFAULT_DAYS) });
  }

  return (
    <section>
      <PageHeader title="Signals">
        What makes your CI slow, costly or busier than it needs to be, and where. Updated every
        hour. <ExternalLink href={SIGNALS_DOCS}>How signals work</ExternalLink>
      </PageHeader>
      <div className="grid max-w-4xl gap-10">
        <RangePicker ranges={RANGES} days={days} onChange={chooseRange} />
        {report.totals.jobs === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            No finished jobs in this range yet. Signals show up within an hour of jobs running in a
            connected repo.
          </p>
        ) : (
          <>
            {/* Every area shows, with the signals that didn't show up named under it, so the page
                says what it looks for and not only what it found. */}
            {(Object.keys(AREAS) as SignalArea[]).map((area) => (
              <AreaSection key={area} area={area} report={report} />
            ))}
            <BreakdownSection report={report} />
          </>
        )}
      </div>
    </section>
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

function AreaSection({ area, report }: { area: SignalArea; report: SignalsReport }) {
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
        <SignalCard key={signal.id} signal={signal} />
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

function SignalCard({ signal }: { signal: Signal }) {
  const copy = SIGNAL_COPY[signal.id];
  // Signals that cost time but no money keep the column, empty, so columns line up down the page.
  const spend = copy.spend !== false;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-[15px] font-medium">
          {copy.title}
          <SignalInfo id={signal.id} />
        </h3>
        <div className="ml-auto flex items-center gap-4 text-sm">
          {copy.action &&
            (copy.action.href.startsWith("/") ? (
              <Link to={copy.action.href} className={LINK}>
                {copy.action.label}
              </Link>
            ) : (
              <a href={copy.action.href} className={LINK}>
                {copy.action.label}
              </a>
            ))}
          {copy.docs && (
            <a
              href={copy.docs}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              Learn more in the GitHub docs
              <ArrowUpRightIcon aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      {/* Fixed columns, so every signal's numbers line up down the page. Phones scroll it. */}
      <Table className="min-w-xl table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>{copy.subject}</TableHead>
            <TableHead className="w-36 text-right">{copy.count}</TableHead>
            <TableHead className="w-36 text-right">{copy.minutes}</TableHead>
            <TableHead className="w-28 text-right">{spend && "Spend"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {signal.rows.map((row) => (
            <TableRow key={`${row.repository}:${row.subject}`}>
              <TableCell className="truncate">
                <SubjectName row={row} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Count value={row.count} />
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                <Count value={row.minutes} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{spend && money(row.cost)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// A runner row opens the runner's panel; a workflow row links to its file.
function SubjectName({ row }: { row: SignalRow }) {
  if (!row.runnerKey)
    return <WorkflowName repository={row.repository} name={row.subject} path={row.workflowPath} />;
  return (
    <RunnerLink
      runner={{ key: row.runnerKey, label: row.subject }}
      className="inline-flex max-w-full items-center gap-2"
      markClassName="size-4"
    >
      <span className="truncate">
        <SubjectText repository={row.repository} name={row.subject} />
      </span>
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
      href={`https://github.com/${repository}/blob/HEAD/${path}`}
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
function BreakdownSection({ report }: { report: SignalsReport }) {
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
      <Table className="min-w-xl table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>{view.label}</TableHead>
            <TableHead className="hidden w-44 sm:table-cell">Share of minutes</TableHead>
            <TableHead className="w-24 text-right">Runs</TableHead>
            <TableHead className="w-24 text-right">Minutes</TableHead>
            <TableHead className="w-28 text-right">Spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <BreakdownLine
              key={`${row.repository}:${row.name}`}
              name={<BreakdownName by={by} row={row} />}
              sums={row}
              total={total}
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
    </Section>
  );
}

function BreakdownLine({
  name,
  sums,
  total,
}: {
  name: ReactNode;
  sums: { runs: number; minutes: number; cost: number };
  total: number;
}) {
  const share = total ? sums.minutes / total : 0;
  return (
    <TableRow>
      <TableCell className="truncate">{name}</TableCell>
      <TableCell className="hidden sm:table-cell">
        <div className="flex items-center gap-2">
          <div aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised-2">
            <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
          </div>
          <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">
            {Math.round(share * 100)}%
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <Count value={sums.runs} />
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        <Count value={sums.minutes} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{money(sums.cost)}</TableCell>
    </TableRow>
  );
}

function BreakdownName({ by, row }: { by: BreakdownBy; row: BreakdownRow }) {
  if (by === "workflow" && row.repository) {
    return <WorkflowName repository={row.repository} name={row.name} path={row.workflowPath} />;
  }
  if (by === "trigger") return triggerName(row.name);
  return row.name;
}
