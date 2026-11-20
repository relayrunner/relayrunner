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
import { authDisabled } from "@/lib/auth-client";
import { DAY_MS, medianText, p90Text } from "@/lib/job-times";
import { useProviderApps } from "@/lib/provider-apps";
import { providerInfo } from "@/lib/provider-catalog";
import {
  optionParam,
  type RangeSearch,
  rangeSearch,
  unlessDefault,
  useRangeReport,
  useSetSearch,
} from "@/lib/search-params";
import {
  costText,
  getProvidersOverview,
  PROVIDER_DEFAULT_RANGE,
  PROVIDER_RANGES,
  type ProvidersOverview,
  type ProviderSummary,
  sampleProvidersOverview,
} from "@/lib/providers";
import { rangeDays, rangePhrase, type TimeRange } from "@/lib/time-range";

function load(range: TimeRange) {
  return authDisabled
    ? Promise.resolve(sampleProvidersOverview(rangeDays(range)))
    : getProvidersOverview(range, { chart: true });
}

const rangeParams = rangeSearch(PROVIDER_RANGES, PROVIDER_DEFAULT_RANGE);
const { rangeOf, toSearch } = rangeParams;

const MINUTE_VIEWS = [
  { value: "minutes", label: "Minutes" },
  { value: "share", label: "Share" },
] as const;
type MinuteView = (typeof MINUTE_VIEWS)[number]["value"];

type ProvidersSearch = RangeSearch & { minutes?: MinuteView };

// The range, and `?minutes=share` when the chart shows each provider's share of the day.
const validateSearch = (search: Record<string, unknown>): ProvidersSearch => ({
  ...rangeParams.validateSearch(search),
  minutes: optionParam(
    search.minutes,
    MINUTE_VIEWS.map((view) => view.value),
  ),
});

export const Route = createFileRoute("/_authed/_workspace/providers/")({
  validateSearch,
  loader: ({ location }) => load(rangeOf(validateSearch(location.search))),
  // A new range loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: ProvidersPage,
});

function ProvidersPage() {
  const search = Route.useSearch();
  const range = rangeOf(search);
  const setSearch = useSetSearch<ProvidersSearch>();
  const overview: ProvidersOverview = useRangeReport(Route.useLoaderData(), range, load);
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
      <PageHeader title="Providers">
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
                  view={search.minutes ?? "minutes"}
                  onView={(view) => setSearch({ minutes: unlessDefault(view, "minutes") })}
                />
              </SectionBoundary>
              <SectionBoundary>
                <DataTable
                  columns={hasChange ? inUseColumns : withoutChange}
                  data={overview.providers}
                  getRowId={(row) => row.provider}
                  initialSorting={[{ id: "jobs", desc: true }]}
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

/**
 * Each provider's billed minutes a day at a time (a week past a month), stacked biggest first, or
 * as its share of the day.
 */
function MinutesChart({
  overview,
  view,
  onView,
}: {
  overview: ProvidersOverview;
  view: MinuteView;
  onView: (view: MinuteView) => void;
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
  const week = overview.bucketMs > DAY_MS;
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Billed minutes {week ? "per week" : "per day"}</h3>
          <p className="text-sm text-muted-foreground">
            {view === "share" ? "Each provider's share of the day." : "Stacked by provider."}
          </p>
        </div>
        <OptionPicker
          label="Show minutes as"
          options={MINUTE_VIEWS}
          value={view}
          onChange={onView}
        />
      </div>
      <StackedBars
        buckets={overview.buckets.map((b) => ({ start: b.start, values: b.minutes }))}
        bucketMs={overview.bucketMs}
        series={series}
        share={view === "share"}
        format={(minutes) => `${minutes.toLocaleString()} min`}
        label={`Billed minutes ${week ? "per week" : "per day"} by provider`}
        footer={(_, total) => <TipRow label="Total" value={`${total.toLocaleString()} min`} />}
      />
      <Legend series={series} />
    </section>
  );
}

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
