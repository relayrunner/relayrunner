import {
  type Platform,
  providerPlans,
  RUNNER_CLOUD_IDS,
  startsAt,
  twoVcpuMinute,
} from "@relayrunner/providers";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { Count } from "@/components/count";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { perMinuteText } from "@/components/provider-plans";
import { ProviderMark } from "@/components/providers";
import { OptionPicker, RangePicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import { DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { authDisabled } from "@/lib/auth-client";
import { medianText, p90Text, plural } from "@/lib/job-times";
import { isKnownProvider, providerInfo } from "@/lib/provider-catalog";
import {
  dayRanges,
  rangeParam,
  unlessDefault,
  useRangeReport,
  useSetSearch,
} from "@/lib/search-params";
import {
  costText,
  getProvidersOverview,
  type ProvidersOverview,
  type ProviderSummary,
  sampleProvidersOverview,
} from "@/lib/providers";

const RANGES = dayRanges(1, 30);

function load(days: number) {
  return authDisabled ? Promise.resolve(sampleProvidersOverview(days)) : getProvidersOverview(days);
}

const DEFAULT_DAYS = 14;
type Search = { days?: number };
const validateSearch = (search: Record<string, unknown>): Search => ({
  days: rangeParam(search.days, RANGES, DEFAULT_DAYS),
});
const daysOf = (search: Search) => search.days ?? DEFAULT_DAYS;

export const Route = createFileRoute("/_authed/_workspace/providers/")({
  validateSearch,
  loader: ({ location }) => load(daysOf(validateSearch(location.search))),
  // A new range loads in the page, keeping the last one up meanwhile.
  shouldReload: ({ cause }) => cause !== "stay",
  component: ProvidersPage,
});

function ProvidersPage() {
  const days = daysOf(Route.useSearch());
  const setSearch = useSetSearch<Search>();
  const overview: ProvidersOverview = useRangeReport(Route.useLoaderData(), days, load);
  const used = new Set(overview.providers.map((p) => p.provider));
  // Third-party runner clouds you add with their own GitHub App and a label, not used here yet,
  // that an operator made Live.
  const unused = RUNNER_CLOUD_IDS.filter(
    (id) => isKnownProvider(id) && providerInfo(id).status === "live" && !used.has(id),
  );

  function chooseRange(next: number) {
    setSearch({ days: unlessDefault(next, DEFAULT_DAYS) });
  }

  return (
    <section>
      <PageHeader title="Providers">
        Where your jobs run, and what each place costs. Add a runner cloud by connecting its GitHub
        App, then use its label in <code>runs-on</code>.
      </PageHeader>
      <div className="grid max-w-5xl gap-8">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">In use</h2>
            <RangePicker ranges={RANGES} days={days} onChange={chooseRange} />
          </div>
          {overview.providers.length === 0 ? (
            <p className="rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
              No jobs in this workspace ran on a provider in the last {plural(overview.days, "day")}
              .
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

        {unused.length > 0 && <AddRunnerCloud ids={unused} />}

        <p className="max-w-3xl text-xs text-muted-foreground">
          Est. cost is at list prices before any included minutes (checked {overview.pricesChecked}
          ), with GitHub's standard runners free in public repos. Starts at is each runner cloud's
          cheapest plan; its page lists them all. Your own machines and other self-hosted runners
          stay on{" "}
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
    meta: NUM,
    cell: ({ getValue }) => getValue().toLocaleString(),
  }),
  column.accessor((row) => row.stat.medianMs ?? undefined, {
    id: "typical",
    header: "Typical job",
    sortFn: "basic",
    meta: NUM,
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

const PLATFORM_FILTERS = [
  { value: "all", label: "All" },
  { value: "x64", label: "Linux x64" },
  { value: "arm", label: "Arm" },
  { value: "mac", label: "macOS" },
  { value: "win", label: "Windows" },
] as const satisfies readonly { value: Platform | "all"; label: string }[];

type CloudRow = {
  id: string;
  name: string;
  featured: boolean;
  platforms: readonly Platform[];
  startsAt: string;
  perMinute: number | null;
  connectUrl?: string;
};

const cloud = dataTableColumns<CloudRow>();
const cloudColumns = cloud.columns([
  cloud.accessor("name", {
    header: "Provider",
    sortFn: "text",
    cell: ({ row }) => (
      <Link
        to="/providers/$provider"
        params={{ provider: row.original.id }}
        className="flex w-fit items-center gap-3 font-medium hover:underline"
      >
        <ProviderMark provider={row.original.id} className="size-7 rounded-md" />
        {row.original.name}
      </Link>
    ),
  }),
  cloud.display({
    id: "platforms",
    header: "Runs on",
    cell: ({ row }) => (
      <span className="flex gap-1">
        {row.original.platforms.map((platform) => (
          <span
            key={platform}
            className="inline-flex h-5 items-center rounded-[5px] border bg-well px-1.5 font-mono text-[11px] text-muted-foreground"
          >
            {platform}
          </span>
        ))}
      </span>
    ),
  }),
  cloud.accessor("startsAt", {
    header: "Starts at",
    cell: ({ getValue }) => <span className="text-ink-2">{getValue()}</span>,
  }),
  cloud.accessor((row) => row.perMinute ?? undefined, {
    id: "perMinute",
    header: "Per minute",
    sortFn: "basic",
    meta: { ...NUM, info: "A 2 vCPU Linux runner at list price, past any included minutes." },
    cell: ({ row }) => perMinuteText(row.original.perMinute),
  }),
  cloud.display({
    id: "connect",
    header: () => <span className="sr-only">Connect</span>,
    meta: { align: "end" },
    cell: ({ row }) =>
      row.original.connectUrl && (
        <Button asChild size="sm" variant="outline">
          <a href={row.original.connectUrl} target="_blank" rel="noreferrer">
            Connect
            <ArrowUpRightIcon aria-hidden />
            <span className="sr-only"> {row.original.name} (opens its site)</span>
          </a>
        </Button>
      ),
  }),
]);

function AddRunnerCloud({ ids }: { ids: string[] }) {
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const rows: CloudRow[] = ids.flatMap((id) => {
    const plans = providerPlans(id);
    if (!plans || (platform !== "all" && !plans.platforms.includes(platform))) return [];
    const info = providerInfo(id);
    return [
      {
        id,
        name: info.name,
        featured: info.featured,
        platforms: plans.platforms,
        startsAt: startsAt(plans),
        perMinute: twoVcpuMinute(id),
        connectUrl: plans.connectUrl,
      },
    ];
  });
  // The names people know first; the rest follow in their own table so they don't bury them.
  const featured = rows.filter((row) => row.featured);
  const more = rows.filter((row) => !row.featured);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 className="font-semibold">Add a runner cloud</h2>
          <p className="text-sm text-muted-foreground">
            Connect its GitHub App to your organization, then use its label in <code>runs-on</code>.
          </p>
        </div>
        <OptionPicker
          label="Runs on"
          options={PLATFORM_FILTERS}
          value={platform}
          onChange={setPlatform}
        />
      </div>
      <DataTable
        columns={cloudColumns}
        data={featured.length > 0 ? featured : more}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "perMinute", desc: false }]}
        rowHeight={53}
        empty="None of the runner clouds you haven't used yet run on this platform."
      />
      {featured.length > 0 && more.length > 0 && (
        <div className="grid gap-3 pt-2">
          <h3 className="text-sm font-semibold">
            More runner clouds <span className="text-muted-foreground">· {more.length}</span>
          </h3>
          <DataTable
            columns={cloudColumns}
            data={more}
            getRowId={(row) => row.id}
            initialSorting={[{ id: "perMinute", desc: false }]}
            rowHeight={53}
          />
        </div>
      )}
    </div>
  );
}
