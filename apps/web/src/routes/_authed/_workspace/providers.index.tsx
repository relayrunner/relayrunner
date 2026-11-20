import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Count } from "@/components/count";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { HostedRunnersTable } from "@/components/hosted-runners-table";
import { ProviderMark } from "@/components/providers";
import { TimeRangePicker } from "@/components/range-picker";
import { DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { authDisabled } from "@/lib/auth-client";
import { medianText, p90Text } from "@/lib/job-times";
import { useProviderApps } from "@/lib/provider-apps";
import { providerInfo } from "@/lib/provider-catalog";
import { type RangeSearch, rangeSearch, useRangeReport, useSetSearch } from "@/lib/search-params";
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
    : getProvidersOverview(range);
}

const { validateSearch, rangeOf, toSearch } = rangeSearch(PROVIDER_RANGES, PROVIDER_DEFAULT_RANGE);

export const Route = createFileRoute("/_authed/_workspace/providers/")({
  validateSearch,
  loader: ({ location }) => load(rangeOf(validateSearch(location.search))),
  // A new range loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: ProvidersPage,
});

function ProvidersPage() {
  const range = rangeOf(Route.useSearch());
  const setSearch = useSetSearch<RangeSearch>();
  const overview: ProvidersOverview = useRangeReport(Route.useLoaderData(), range, load);
  const { current } = Route.useRouteContext();
  const installed = useProviderApps(current.workspace.id);
  // Connected: the org installed the cloud's GitHub App, or a job ran on it in this range (GitHub
  // can't list a personal account's apps).
  const connected = useMemo(
    () => new Set<string>([...(installed ?? []), ...overview.providers.map((p) => p.provider)]),
    [installed, overview],
  );

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
            <SectionBoundary>
              <DataTable
                columns={inUseColumns}
                data={overview.providers}
                getRowId={(row) => row.provider}
                initialSorting={[{ id: "jobs", desc: true }]}
                rowHeight={53}
              />
            </SectionBoundary>
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
