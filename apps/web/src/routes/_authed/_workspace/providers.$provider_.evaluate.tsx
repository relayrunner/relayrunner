// Evaluate a provider: run one workflow on it five times and compare with how it runs today
// (apps/api/src/reports/evaluations.ts). Without `?id` it walks through connecting the provider and
// picking a workflow; with one it shows that evaluation's runs, then the comparison.
import { PageNotFound } from "@/components/page-message";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { evaluationSizes } from "@/lib/evaluations";
import { usePageTitle } from "@/lib/page-title";
import { isKnownProvider, providerInfo } from "@/lib/provider-catalog";
import { canManage } from "@/lib/roles";
import { EvaluationView, EvaluateHeader } from "@/features/evaluations/evaluation-view";
import { Setup } from "@/features/evaluations/setup";

type EvaluateSearch = { id?: string };

export const Route = createFileRoute("/_authed/_workspace/providers/$provider_/evaluate")({
  validateSearch: (search: Record<string, unknown>): EvaluateSearch => ({
    id: typeof search.id === "string" && search.id ? search.id : undefined,
  }),
  component: EvaluatePage,
});

// An unknown provider, or one that can't run evaluations, says so inside the app. Throwing
// notFound() would show it in place of the whole app, sidebar included.
function EvaluatePage() {
  const { provider } = Route.useParams();
  if (!isKnownProvider(provider) || evaluationSizes(provider).length === 0) return <PageNotFound />;
  return <EvaluateView provider={provider} />;
}

function EvaluateView({ provider }: { provider: string }) {
  const { id } = Route.useSearch();
  const { current } = Route.useRouteContext();
  const info = providerInfo(provider);
  usePageTitle(`Evaluate ${info.name}`);
  return (
    <section className="grid max-w-5xl gap-8">
      <Link
        to="/providers/$provider"
        params={{ provider }}
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        {info.name}
      </Link>
      {id ? (
        <EvaluationView key={id} id={id} provider={provider} editable={canManage(current.role)} />
      ) : (
        <>
          <EvaluateHeader provider={provider} />
          <Setup
            provider={provider}
            workspaceId={current.workspace.id}
            editable={canManage(current.role)}
          />
        </>
      )}
    </section>
  );
}
