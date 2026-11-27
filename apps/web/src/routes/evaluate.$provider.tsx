// The public start of evaluating a provider, where the site's runner list sends people
// (relayrunner.dev/integrations). It shows the same steps as the dashboard's Evaluate page with
// connecting GitHub as the first one, so signing up reads as part of the evaluation:
//
// - Signed out: "Continue with GitHub" installs the App and signs up in one trip
//   (/api/github/signup), then lands on the dashboard's Evaluate page for this provider.
//   "Sign in" is for an existing account and comes back here.
// - Signed in with no workspace yet: the install is the remaining part of the GitHub step.
// - Signed in with a workspace: straight on to the dashboard's Evaluate page.
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, GitBranchIcon, RotateCcwIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { Brand } from "@/components/brand";
import { EVALUATE_STEP, EvaluateStepper } from "@/components/evaluate-stepper";
import { LegalNotice } from "@/components/legal-notice";
import { GithubIcon } from "@/components/provider-logos";
import { providerStyle, TILE } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { authDisabled, getSession, organization, signIn } from "@/lib/auth-client";
import { EVALUATION_RUNS, evaluationSizes } from "@/lib/evaluations";
import { sampleEvaluation } from "@/lib/sample/evaluations";
import { githubInstallHref, githubOutcomes } from "@/lib/github";
import { usePageTitle } from "@/lib/page-title";
import { isKnownProvider, providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";
import { Results } from "./_authed/_workspace/providers.$provider_.evaluate";

const SITE_RUNNERS = "https://relayrunner.dev/integrations";

// `as`: which state to show with auth disabled (local development and screenshots).
type StartSearch = { as?: "signedout" | "install" | "requested" };

export const Route = createFileRoute("/evaluate/$provider")({
  validateSearch: (search: Record<string, unknown>): StartSearch => ({
    as:
      search.as === "install" || search.as === "requested" || search.as === "signedout"
        ? search.as
        : undefined,
  }),
  beforeLoad: async ({ params, search }) => {
    if (!isKnownProvider(params.provider) || evaluationSizes(params.provider).length === 0)
      throw notFound();
    if (authDisabled) return { state: search.as ?? "signedout", login: "octocat" };
    const session = await getSession();
    if (!session) return { state: "signedout" as const, login: null };
    const { data } = await organization.list();
    if (data?.length)
      throw redirect({
        to: "/providers/$provider/evaluate",
        params: { provider: params.provider },
      });
    return { state: "install" as const, login: session.user.name };
  },
  component: StartPage,
});

function StartPage() {
  const { provider } = Route.useParams();
  const { state, login } = Route.useRouteContext();
  const info = providerInfo(provider);
  usePageTitle(`Evaluate ${info.name}`);
  const { icon, tile } = providerStyle(provider);
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <a href="https://relayrunner.dev" aria-label="RelayRunner home">
            <Brand className="text-lg" />
          </a>
        </div>
      </header>
      <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 sm:px-8 sm:py-10">
        <a
          href={SITE_RUNNERS}
          className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
          All runners
        </a>
        <header className="flex min-w-0 items-center gap-3.5">
          <span className={cn(TILE, "size-12 rounded-[10px] [&_svg]:scale-150", tile)}>{icon}</span>
          <div className="grid min-w-0 gap-1">
            <h1 className="text-2xl leading-tight font-bold tracking-[-0.01em]">
              Evaluate {info.name}
            </h1>
            <p className="text-muted-foreground">
              Run one of your workflows on {info.name} {EVALUATION_RUNS} times and compare it with
              how it runs today. Nothing in your repo changes.
            </p>
          </div>
        </header>
        <EvaluateStepper at={EVALUATE_STEP.github} provider={provider} />
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10">
          <GitHubStep provider={provider} state={state} login={login} />
          <WhatHappens provider={provider} />
        </div>
        <Example provider={provider} />
      </main>
    </div>
  );
}

function SubStep({
  n,
  done,
  current,
  children,
}: {
  n: number;
  done?: boolean;
  current?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={cn("flex items-center gap-3", !done && !current && "text-muted-foreground")}>
      {/* As wide as the GitHub badge above, so the circles share its center line. */}
      <span className="flex w-9 shrink-0 justify-center">
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full border text-xs",
            done && "border-go-edge bg-go-soft text-go",
            current && "border-foreground",
          )}
        >
          {done ? <CheckIcon aria-label="Done" className="size-3" /> : n}
        </span>
      </span>
      {children}
    </li>
  );
}

function GitHubStep({
  provider,
  state,
  login,
}: {
  provider: string;
  state: "signedout" | "install" | "requested";
  login: string | null;
}) {
  const { name } = providerInfo(provider);
  const next = `/providers/${provider}/evaluate`;
  const back = `/evaluate/${provider}`;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = state !== "signedout";

  async function signInOnly() {
    setError(null);
    setPending(true);
    const { error } = await signIn.social({
      provider: "github",
      callbackURL: back,
      errorCallbackURL: `/login?redirect=${encodeURIComponent(back)}`,
    });
    if (error) {
      setError(error.message ?? "Sign-in failed");
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-raised-2">
          <GithubIcon className="size-4" />
        </span>
        <div className="grid gap-1">
          <span className="font-semibold">
            {state === "requested" ? "Waiting on an org owner" : "Start with GitHub"}
          </span>
          <span className="text-sm text-muted-foreground">
            {state === "requested"
              ? githubOutcomes.requested.message
              : `The evaluation runs one of your workflows, so RelayRunner needs its GitHub App on the account or organization whose CI you want to try on ${name}. You'll pick the workflow next.`}
          </span>
        </div>
      </div>
      <ol className="grid gap-2.5 border-t pt-4 text-sm">
        <SubStep n={1} done={signedIn} current={!signedIn}>
          {signedIn && login ? `Signed in as ${login}` : "Sign up with GitHub"}
        </SubStep>
        <SubStep n={2} current={signedIn}>
          Install the RelayRunner GitHub App, on all repos or just the ones you'll evaluate
        </SubStep>
        <SubStep n={3}>Connect {name} and pick a workflow</SubStep>
      </ol>
      <div className="grid gap-3 border-t pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button asChild size="lg" className="font-bold">
            {/* A full page load: one trip to GitHub installs the App (and signs up), then lands on
                the dashboard's Evaluate page for this provider. */}
            <a
              href={
                signedIn
                  ? githubInstallHref(next)
                  : `/api/github/signup?next=${encodeURIComponent(next)}`
              }
            >
              <GithubIcon className="size-[18px]" />
              {state === "requested"
                ? "Install on another account"
                : signedIn
                  ? "Install on GitHub"
                  : "Continue with GitHub"}
            </a>
          </Button>
          {!signedIn && (
            <span className="text-sm text-muted-foreground">
              Already have an account?{" "}
              <button
                type="button"
                className="text-foreground underline-offset-4 hover:underline disabled:opacity-50"
                disabled={pending}
                onClick={() => void signInOnly()}
              >
                Sign in
              </button>
            </span>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!signedIn && (
          <div className="[&>p]:text-left">
            <LegalNotice action="continuing" />
          </div>
        )}
      </div>
    </div>
  );
}

function WhatHappens({ provider }: { provider: string }) {
  const { name } = providerInfo(provider);
  return (
    <div className="grid gap-3">
      <h2 className="text-sm font-medium">What happens</h2>
      <ul className="grid gap-2 text-sm text-muted-foreground">
        <li className="flex gap-2">
          <WorkflowIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>Pick a workflow you already run. Its steps stay the same.</span>
        </li>
        <li className="flex gap-2">
          <RotateCcwIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            It runs {EVALUATION_RUNS} times on {name}, cold cache then warm.
          </span>
        </li>
        <li className="flex gap-2">
          <GitBranchIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>See its time and cost next to how it runs today.</span>
        </li>
      </ul>
    </div>
  );
}

function Example({ provider }: { provider: string }) {
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium">What you'll get</h2>
        <span className="text-xs text-muted-foreground">Sample data</span>
      </div>
      <div
        inert
        className="relative max-h-[520px] overflow-hidden rounded-xl border bg-background p-5 select-none"
      >
        <Results
          report={sampleEvaluation(provider, EVALUATION_RUNS)}
          editable={false}
          onChange={() => {}}
          preview
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background to-transparent" />
      </div>
    </div>
  );
}
