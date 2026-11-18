import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { HostedRunnersTable } from "@/components/hosted-runners-table";
import { PageHeader } from "@/components/page-header";
import { authDisabled } from "@/lib/auth-client";
import { useProviderApps } from "@/lib/provider-apps";
import { getProvidersOverview, sampleProvidersOverview } from "@/lib/providers";

// A cloud counts as connected when a job ran on it in this many days, even where GitHub can't
// tell us the org installed its app (a personal account).
const USED_DAYS = 30;

export const Route = createFileRoute("/_authed/_workspace/providers/")({
  loader: () =>
    authDisabled
      ? Promise.resolve(sampleProvidersOverview(USED_DAYS))
      : getProvidersOverview(USED_DAYS),
  component: ProvidersPage,
});

function ProvidersPage() {
  const { current } = Route.useRouteContext();
  const overview = Route.useLoaderData();
  const installed = useProviderApps(current.workspace.id);
  const connected = useMemo(
    () => new Set<string>([...(installed ?? []), ...overview.providers.map((p) => p.provider)]),
    [installed, overview],
  );

  return (
    <section>
      <PageHeader title="Providers">
        What each runner cloud charges. Connect one by installing its GitHub App, then use its label
        in <code>runs-on</code>.
      </PageHeader>
      <div className="grid max-w-6xl gap-3">
        <SectionBoundary>
          <HostedRunnersTable connected={connected} />
        </SectionBoundary>
        <p className="max-w-3xl text-xs text-muted-foreground">
          List prices and plans from each provider's own pricing page, checked{" "}
          {overview.pricesChecked}. Plan is the cheapest one you can run real CI on, leaving out
          trials and one-machine free tiers, and each provider's page lists them all. Per minute is
          past any included minutes. What your jobs used on each cloud is on{" "}
          <Link to="/runners" className="underline">
            Runners
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
