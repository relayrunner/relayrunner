import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Count } from "@/components/count";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { HostedRunnersTable } from "@/components/hosted-runners-table";
import { ProviderMark } from "@/components/providers";
import { Change } from "@/components/change";
import { TipRow } from "@/components/chart-parts";
import { OptionPicker, TimeRangePicker } from "@/components/range-picker";
import { Legend, seriesColor, StackedBars } from "@/components/stacked-bars";
import { DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { type ExportColumn, seconds } from "@/lib/table-export";
import { loadPage, pageQuery, usePageReport } from "@/lib/query";
import { DAY_MS, medianText, p90Text } from "@/lib/job-times";
import { useProviderApps } from "@/lib/provider-apps";
import { providerInfo } from "@/lib/provider-catalog";
import {
  optionParam,
  type RangeSearch,
  rangeSearch,
  unlessDefault,
  useSetSearch,
} from "@/lib/search-params";
import {
  type ChartPer,
  costText,
  getProvidersOverview,
  PROVIDER_DEFAULT_RANGE,
  PROVIDER_RANGES,
  type ProvidersOverview,
  type ProviderSummary,
} from "@/lib/providers";
import { rangeDays, rangePhrase, resolveRange, type TimeRange } from "@/lib/time-range";
import { startOfDay } from "@/lib/time-zone";

/** The overview, with where its range started, so its bars never meet another range's start. */
type LoadedOverview = ProvidersOverview & { from: number };

async function load(range: TimeRange, per: ChartPer): Promise<LoadedOverview> {
  const { from } = resolveRange(range);
  const overview = await getProvidersOverview(range, { chart: per });
  return { ...overview, from };
}

const overviewQuery = (range: TimeRange, per: ChartPer) =>
  pageQuery(["providers", range, per], () => load(range, per));

const rangeParams = rangeSearch(PROVIDER_RANGES, PROVIDER_DEFAULT_RANGE);
const { rangeOf, toSearch } = rangeParams;

const PER_OPTIONS = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
] as const;

type ProvidersSearch = RangeSearch & { per?: ChartPer };

// Weekly bars, so week over week shows, once a range holds two weeks to compare; hourly bars over
// a day or two, where a bar a day would say little; daily in between.
const offersWeeks = (range: TimeRange) => rangeDays(range) >= 14;
const hourly = (range: TimeRange) => {
  const { from, to } = resolveRange(range);
  return to - from <= 2 * DAY_MS;
};
function perOf(search: ProvidersSearch): ChartPer {
  const range = rangeOf(search);
  if (offersWeeks(range)) return search.per ?? "week";
  return hourly(range) ? "hour" : "day";
}

// The range, and `?per=day` for daily bars over a range that offers weekly ones.
const validateSearch = (search: Record<string, unknown>): ProvidersSearch => ({
  ...rangeParams.validateSearch(search),
  // The default first: optionParam drops it, so the URL only ever holds `?per=day`.
  per: optionParam(search.per, ["week", "day"] as const),
});

export const Route = createFileRoute("/_authed/_workspace/providers/")({
  validateSearch,
  loader: ({ location }) => {
    const search = validateSearch(location.search);
    return loadPage(overviewQuery(rangeOf(search), perOf(search)));
  },
  // A new range loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: ProvidersPage,
});

function ProvidersPage() {
  const search = Route.useSearch();
  const range = rangeOf(search);
  const per = perOf(search);
  const setSearch = useSetSearch<ProvidersSearch>();
  const { report: overview } = usePageReport(overviewQuery(range, per), Route.useLoaderData());
  const { current } = Route.useRouteContext();
  const installed = useProviderApps(current.workspace.id);
  // Connected: the org installed the cloud's GitHub App, or a job ran on it in this range (GitHub
  // can't list a personal account's apps).
  const connected = useMemo(
    () => new Set<string>([...(installed ?? []), ...overview.providers.map((p) => p.provider)]),
    [installed, overview],
  );

  // Last month reaches past what the API keeps for its trend.
  const hasChange = overview.providers.some((p) => p.priorBilledMinutes !== null);

  function chooseRange(next: TimeRange) {
    setSearch(toSearch(next));
  }

  return (
    <section>
      <PageHeader className="max-w-6xl" title="Providers">
        Where your jobs run, and what each place costs. Add a runner cloud by connecting its GitHub
        App, then use its label in <code>runs-on</code>.
      </PageHeader>
      <div className="grid max-w-6xl gap-8">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">In use</h2>
            <TimeRangePicker {...PROVIDER_RANGES} value={range} onChange={chooseRange} />
          </div>
          {overview.providers.length === 0 ? (
            <p className="rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
              No jobs in this workspace ran on a provider in {rangePhrase(range)}.
            </p>
          ) : (
            <>
              <SectionBoundary>
                <MinutesChart
                  overview={overview}
                  per={offersWeeks(range) ? per : null}
                  onPer={(next) => setSearch({ per: unlessDefault(next, "week") })}
                />
              </SectionBoundary>
              <SectionBoundary>
                <DataTable
                  columns={hasChange ? inUseColumns : withoutChange}
                  data={overview.providers}
                  getRowId={(row) => row.provider}
                  initialSorting={[{ id: "jobs", desc: true }]}
                  exportAs={{ name: "providers", columns: EXPORT_COLUMNS }}
                  rowHeight={53}
                />
              </SectionBoundary>
            </>
          )}
        </div>

        <div className="grid gap-3">
          <h2 className="font-semibold">Runner clouds</h2>
          <SectionBoundary>
            <HostedRunnersTable connected={connected} />
          </SectionBoundary>
        </div>

        <p className="max-w-3xl text-xs text-muted-foreground">
          Est. cost is at list prices before any included minutes (checked {overview.pricesChecked}
          ), with GitHub's standard runners free in public repos. Plan is each runner cloud's
          cheapest plan for real CI, leaving out trials and one-machine free tiers, and its page
          lists them all. Per minute is past any included minutes. Your own machines and other
          self-hosted runners stay on{" "}
          <Link to="/runners" className="underline">
            Runners
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

/** Billed minutes against the window before, in whole percent, or null when unknown or tiny. */
function minutesChange({ billedMinutes, priorBilledMinutes: prior }: ProviderSummary) {
  if (prior === null || prior < 1) return null;
  return Math.round(((billedMinutes - prior) / prior) * 100);
}

/** What a bar of `bucketMs` covers, for the chart's title. */
const perText = (bucketMs: number) =>
  bucketMs > DAY_MS ? "per week" : bucketMs < DAY_MS ? "per hour" : "per day";

/**
 * Each provider's billed minutes an hour, a day or a week at a time, stacked biggest first, so the
 * bars show the volume and how it splits. `per` is null when the range is too short for weeks.
 */
function MinutesChart({
  overview,
  per,
  onPer,
}: {
  /** Its `from` is the range's start: a first bar that began before it is only counted from there. */
  overview: LoadedOverview;
  per: ChartPer | null;
  onPer: (per: ChartPer) => void;
}) {
  const series = useMemo(
    () =>
      overview.providers
        .filter((p) => p.billedMinutes > 0)
        .toSorted((a, b) => b.billedMinutes - a.billedMinutes)
        .map((p, i) => ({
          key: p.provider,
          label: providerInfo(p.provider).name,
          color: seriesColor(i),
        })),
    [overview],
  );
  // One bar says nothing a table row doesn't.
  if (overview.buckets.length < 2 || series.length === 0) return null;
  const title = `Billed minutes ${perText(overview.bucketMs)}`;
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">Stacked by provider.</p>
        </div>
        {per && <OptionPicker label="Bars" options={PER_OPTIONS} value={per} onChange={onPer} />}
      </div>
      <StackedBars
        buckets={overview.buckets.map((b) => ({
          start: Math.max(b.start, startOfDay(overview.from)),
          values: b.minutes,
        }))}
        bucketMs={overview.bucketMs}
        series={series}
        format={(minutes) => `${minutes.toLocaleString()} min`}
        label={`${title} by provider`}
        footer={(_, total) => <TipRow label="Total" value={`${total.toLocaleString()} min`} />}
      />
      <Legend series={series} />
    </section>
  );
}

// A provider's export: its jobs, billed minutes, typical job in seconds and cost in USD.
const EXPORT_COLUMNS: ExportColumn<ProviderSummary>[] = [
  { header: "Provider", value: (row) => providerInfo(row.provider).name },
  { header: "Jobs", value: (row) => row.jobs },
  { header: "Failed", value: (row) => row.failures },
  { header: "Billed minutes", value: (row) => row.billedMinutes },
  { header: "Billed minutes before", value: (row) => row.priorBilledMinutes },
  { header: "Typical job (s)", value: (row) => seconds(row.stat.medianMs) },
  { header: "Est. cost (USD)", value: (row) => row.cost },
];

const column = dataTableColumns<ProviderSummary>();
const inUseColumns = column.columns([
  column.accessor((row) => providerInfo(row.provider).name, {
    id: "provider",
    header: "Provider",
    sortFn: "text",
    cell: ({ row }) => (
      <Link
        to="/providers/$provider"
        params={{ provider: row.original.provider }}
        className="flex w-fit items-center gap-3 font-medium hover:underline"
      >
        <ProviderMark provider={row.original.provider} className="size-7 rounded-md" />
        {providerInfo(row.original.provider).name}
      </Link>
    ),
  }),
  column.accessor("jobs", {
    header: "Jobs",
    sortFn: "basic",
    sortDescFirst: true,
    meta: NUM,
    cell: ({ getValue }) => <Count value={getValue()} />,
  }),
  column.accessor("billedMinutes", {
    header: "Billed minutes",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { ...NUM, hideOnPhone: true },
    cell: ({ getValue }) => getValue().toLocaleString(),
  }),
  column.accessor((row) => minutesChange(row) ?? undefined, {
    id: "change",
    header: "Change",
    sortFn: "basic",
    sortDescFirst: true,
    meta: {
      ...NUM,
      hideOnPhone: true,
      info: "Billed minutes against as long a stretch just before, or the same days last week or month.",
    },
    cell: ({ row }) =>
      row.original.priorBilledMinutes === 0 && row.original.billedMinutes > 0 ? (
        "New"
      ) : (
        <Change value={minutesChange(row.original)} />
      ),
  }),
  column.accessor((row) => row.stat.medianMs ?? undefined, {
    id: "typical",
    header: "Typical job",
    sortFn: "basic",
    meta: { ...NUM, hideOnPhone: true },
    cell: ({ row }) => (
      <span title={p90Text(row.original.stat)}>{medianText(row.original.stat)}</span>
    ),
  }),
  column.accessor("cost", {
    header: "Est. cost",
    sortFn: "basic",
    sortDescFirst: true,
    meta: NUM,
    cell: ({ row }) => costText(row.original),
  }),
]);

// Last month has no trend: the month before it is past what the API keeps.
const withoutChange = inUseColumns.filter((c) => c.id !== "change");
