import { SectionBoundary } from "@/components/error-boundary";
import { createFileRoute } from "@tanstack/react-router";
import { ChartBarBigIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { OptionPicker, TimeRangePicker } from "@/components/range-picker";
import { ExternalLink } from "@/components/run-sheet";
import {
  PHONE_HIDDEN,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadPage, pageQuery, usePageReport } from "@/lib/query";
import {
  AREAS,
  BREAKDOWN_VIEWS,
  type BreakdownBy,
  getSignals,
  isFiltered,
  rowFilter,
  type SignalArea,
  type SignalFilter,
  type SignalsReport,
} from "@/lib/signals";
import { unlessDefault, useSetSearch } from "@/lib/search-params";
import { type TimeRange } from "@/lib/time-range";
import { cn } from "@/lib/utils";
import {
  validateSearch,
  rangeOf,
  filterOf,
  type Search,
  keyOf,
  ranges,
  SIGNALS_DOCS,
  FILTERED_RANGES,
  RANGES,
  BREAKDOWNS,
} from "@/features/signals/search";
import { spansRepos, AreaSection, Section, FIGURE_HEAD } from "@/features/signals/signal-card";
import { FilterBar } from "@/features/signals/filter-bar";
import { RunsPanel } from "@/features/signals/runs-panel";
import { BreakdownLine, BreakdownName } from "@/features/signals/breakdown";

const signalsQuery = (range: TimeRange, filter: SignalFilter) =>
  pageQuery(["signals", range, filter], () => getSignals(range, filter));

export const Route = createFileRoute("/_authed/_workspace/signals")({
  validateSearch,
  loader: ({ location }) => {
    const search = validateSearch(location.search);
    return loadPage(signalsQuery(rangeOf(search), filterOf(search)));
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
  const { report } = usePageReport(signalsQuery(range, filter), Route.useLoaderData());
  const manyRepos = spansRepos(report);

  function chooseRange(next: TimeRange) {
    setSearch(ranges.toSearch(next));
  }

  return (
    <section>
      <PageHeader className="max-w-4xl" title="Signals">
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
          <SectionBoundary>
            {filtered && <FilterBar filter={filter} report={report} range={range} />}
          </SectionBoundary>
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
              <SectionBoundary key={area}>
                <AreaSection area={area} report={report} manyRepos={manyRepos} />
              </SectionBoundary>
            ))}
            <SectionBoundary>
              <BreakdownSection report={report} manyRepos={manyRepos} />
            </SectionBoundary>
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
