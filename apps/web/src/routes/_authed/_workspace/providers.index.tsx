import { PROVIDER_IDS, PROVIDERS as PROVIDER_INFO } from "@relayrunner/providers";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ProviderMark } from "@/components/providers";
import { RangePicker } from "@/components/range-picker";
import { authDisabled } from "@/lib/auth-client";
import { medianText, plural } from "@/lib/job-times";
import {
  costText,
  getProvidersOverview,
  type ProvidersOverview,
  sampleProvidersOverview,
} from "@/lib/providers";

const RANGES = [1, 7, 14] as const;

function load(days: number) {
  return authDisabled ? Promise.resolve(sampleProvidersOverview(days)) : getProvidersOverview(days);
}

export const Route = createFileRoute("/_authed/_workspace/providers/")({
  loader: () => load(14),
  component: ProvidersPage,
});

function ProvidersPage() {
  const [overview, setOverview] = useState<ProvidersOverview>(Route.useLoaderData());
  const used = new Set(overview.providers.map((p) => p.provider));
  // "Other" is where unrecognised labels land, not something to set up.
  const unused = PROVIDER_IDS.filter((id) => id !== "other" && !used.has(id));

  function chooseRange(days: number) {
    load(days)
      .then(setOverview)
      .catch(() => undefined);
  }

  return (
    <section>
      <PageHeader title="Providers">
        Where your jobs run, and what each place costs. Pick one to see its runner types, setup and
        busiest workflows.
      </PageHeader>
      <div className="grid max-w-5xl gap-8">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">In use</h2>
            <RangePicker ranges={RANGES} days={overview.days} onChange={chooseRange} />
          </div>
          {overview.providers.length === 0 ? (
            <p className="rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
              No jobs in this workspace ran on a provider in the last {plural(overview.days, "day")}
              .
            </p>
          ) : (
            <InUse overview={overview} />
          )}
        </div>

        {unused.length > 0 && (
          <div className="grid gap-3">
            <h2 className="font-semibold">Not used yet</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {unused.map((provider) => (
                <div key={provider} className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
                  <span className="flex items-center gap-2.5 font-medium">
                    <ProviderMark provider={provider} className="size-7 rounded-md" />
                    {PROVIDER_INFO[provider].name}
                  </span>
                  <p className="flex-1 text-sm text-muted-foreground">
                    {PROVIDER_INFO[provider].summary}
                  </p>
                  <Link
                    to="/providers/$provider"
                    params={{ provider }}
                    className="text-sm font-medium hover:underline"
                  >
                    How to set up
                  </Link>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="max-w-3xl text-xs text-muted-foreground">
          Your own machines and other self-hosted runners stay on{" "}
          <Link to="/runners" className="underline">
            Runners
          </Link>
          . Labels RelayRunner doesn't recognise land under Other. Costs are estimates at list
          prices (checked {overview.pricesChecked}), with GitHub's standard runners free in public
          repos.
        </p>
      </div>
    </section>
  );
}

function InUse({ overview }: { overview: ProvidersOverview }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="px-4 py-2 text-left font-normal">
              Provider
            </th>
            {["Jobs", "Billed minutes", "Typical job", "Est. cost"].map((head) => (
              <th
                key={head}
                scope="col"
                className="px-4 py-2 text-right font-normal whitespace-nowrap"
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {overview.providers.map((row) => (
            <tr key={row.provider} className="border-b last:border-0">
              <td className="px-4 py-2.5">
                <Link
                  to="/providers/$provider"
                  params={{ provider: row.provider }}
                  className="flex w-fit items-center gap-2.5 font-medium hover:underline"
                >
                  <ProviderMark provider={row.provider} className="size-6 rounded-md" />
                  {PROVIDER_INFO[row.provider].name}
                </Link>
              </td>
              <Num>{row.jobs.toLocaleString()}</Num>
              <Num>{row.billedMinutes.toLocaleString()}</Num>
              <Num>{medianText(row.stat)}</Num>
              <Num>{costText(row)}</Num>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Num({ children }: { children: string }) {
  return (
    <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums">
      {children}
    </td>
  );
}
