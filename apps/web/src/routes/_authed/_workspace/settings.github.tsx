import { SectionBoundary } from "@/components/error-boundary";
import { createFileRoute } from "@tanstack/react-router";
import { CircleCheck, ExternalLink, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ActionsMinutes, OverageBanner, useActionsUsage } from "@/components/actions-minutes";
import { PageHeader } from "@/components/page-header";
import { PublicRepoMark } from "@/components/public-repo";
import { DOCS_URL } from "@/components/site-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type AccountUsage, type ActionsUsage } from "@/lib/actions-usage";
import { authDisabled, signIn } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { githubOutcomes as outcomes, isGitHubOutcome, type GitHubOutcome } from "@/lib/github";
import {
  checkLabels,
  getRepoChecks,
  type RepoChecks,
  type RepoChecksView,
} from "@/lib/repo-checks";
import {
  getRateLimits,
  type Installation,
  type RateLimitBucket,
  type RateLimits,
} from "@/lib/workspace";

export const Route = createFileRoute("/_authed/_workspace/settings/github")({
  validateSearch: (search: Record<string, unknown>): { github?: GitHubOutcome } => ({
    github: isGitHubOutcome(search.github) ? search.github : undefined,
  }),
  component: GitHubSettingsPage,
});

function GitHubSettingsPage() {
  const { current } = Route.useRouteContext();
  const { github } = Route.useSearch();
  const { workspace } = current;
  const { usage: minutes, refresh, refreshing } = useActionsUsage();
  // Previews without an API show the sample accounts as connected accounts.
  const installations =
    authDisabled && current.installations.length === 0
      ? sampleInstallations(minutes)
      : current.installations;

  // A workspace is one installation (#316), so there's exactly one to show.
  const installation = installations[0];

  return (
    <section>
      <PageHeader className="max-w-3xl" title="GitHub">
        {workspace.name} is the RelayRunner GitHub App installed on this account. Its repos' jobs
        are what this workspace routes.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        {github && <GitHubNotice outcome={github} />}
        {minutes && installation && (
          <OverageBanner
            accounts={minutes.accounts.filter((a) => a.installationId === installation.id)}
          />
        )}

        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Installation</CardTitle>
            <CardDescription>
              Choose which repos RelayRunner sees, or uninstall it, on GitHub. Uninstalling deletes
              this workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            {installation ? (
              <ul className="grid gap-5">
                <ConnectedOrg
                  installation={installation}
                  minutes={minutes?.accounts.find((a) => a.installationId === installation.id)}
                  onRefresh={authDisabled ? undefined : refresh}
                  refreshing={refreshing}
                />
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Couldn't find the installation.</p>
            )}
          </CardContent>
        </Card>

        {installation && !installation.suspendedAt && (
          <SectionBoundary>
            <PullRequestChecks workspaceId={workspace.id} />
          </SectionBoundary>
        )}
      </div>
    </section>
  );
}

function GitHubNotice({ outcome }: { outcome: GitHubOutcome }) {
  const { tone, message } = outcomes[outcome];
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border px-4 py-3 text-sm",
        tone === "go" ? "border-go-edge bg-go-soft" : "border-run-edge bg-run/15",
      )}
    >
      <p className="min-w-0 flex-1 basis-60">{message}</p>
      {outcome === "reauth" && <SignInAgain />}
    </div>
  );
}

function sampleInstallations(usage: ActionsUsage | null): Installation[] {
  return (usage?.accounts ?? []).map((account) => ({
    id: account.installationId,
    accountLogin: account.accountLogin,
    accountType: account.accountType,
    repositorySelection: "all",
    suspendedAt: null,
    settingsUrl:
      account.accountType === "User"
        ? `https://github.com/settings/installations/${account.installationId}`
        : `https://github.com/organizations/${account.accountLogin}/settings/installations/${account.installationId}`,
  }));
}

function ConnectedOrg({
  installation,
  minutes,
  onRefresh,
  refreshing,
}: {
  installation: Installation;
  minutes?: AccountUsage;
  onRefresh?: () => void;
  refreshing: boolean;
}) {
  const { accountLogin, repositorySelection, suspendedAt, settingsUrl } = installation;
  return (
    <li className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <OrgName installation={installation}>
          <span className="text-muted-foreground">
            {repositorySelection === "all" ? "All repos" : "Selected repos"}
          </span>
        </OrgName>
        <div className="flex items-center gap-2">
          {suspendedAt ? (
            <Badge variant="run">Suspended</Badge>
          ) : (
            <Badge variant="go">Active</Badge>
          )}
          <Button asChild variant="outline" size="xs">
            <a
              href={settingsUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`${suspendedAt ? "Fix" : "Manage"} ${accountLogin} on GitHub`}
            >
              {suspendedAt ? "Fix on GitHub" : "Manage on GitHub"}
              <ExternalLink aria-hidden />
            </a>
          </Button>
        </div>
      </div>
      {/* A suspended installation can't get a token, so there's nothing to read. */}
      {minutes && (
        <ActionsMinutes
          usage={minutes}
          onRefresh={suspendedAt ? undefined : onRefresh}
          refreshing={refreshing}
        />
      )}
      <SectionBoundary>
        {!suspendedAt && <ApiUsage installationId={installation.id} />}
      </SectionBoundary>
    </li>
  );
}

type ChecksState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; view: RepoChecksView };

/**
 * The pull request checks each repo turns on in its relayrunner.yml. Read-only: a repo changes
 * its checks in the file, which a pull request can't change for itself.
 */
function PullRequestChecks({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<ChecksState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    getRepoChecks(workspaceId).then(
      (view) => live && setState({ kind: "ready", view }),
      () => live && setState({ kind: "error" }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Pull request checks</CardTitle>
        <CardDescription>
          Each repo turns on its checks in <code>relayrunner.yml</code> on its default branch. To
          change them, edit that file.{" "}
          <a
            className="text-foreground underline underline-offset-2"
            href={`${DOCS_URL}/concepts/optimized-checks`}
            target="_blank"
            rel="noreferrer"
          >
            Optimized checks
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 text-sm">
        {state.kind === "loading" && (
          <p className="text-muted-foreground">Reading each repo's relayrunner.yml…</p>
        )}
        {state.kind === "error" && (
          <p className="text-muted-foreground">Couldn't read the repos' checks from GitHub.</p>
        )}
        {state.kind === "ready" && <RepoChecksList view={state.view} />}
      </CardContent>
    </Card>
  );
}

function RepoChecksList({ view }: { view: RepoChecksView }) {
  const { repositories, checked, total, lintAvailable } = view;
  return (
    <div className="grid gap-3">
      {repositories.length === 0 ? (
        <p className="text-muted-foreground">
          No repo has a relayrunner.yml yet. Add one with <code>checks: pr-title: true</code> to
          start.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {repositories.map((repo) => (
            <RepoChecksRow key={repo.repository} repo={repo} lintAvailable={lintAvailable} />
          ))}
        </ul>
      )}
      {checked < total && (
        <p className="text-xs text-muted-foreground">
          Showing the first {count(checked)} of {count(total)} repos by name.
        </p>
      )}
    </div>
  );
}

function RepoChecksRow({ repo, lintAvailable }: { repo: RepoChecks; lintAvailable: boolean }) {
  const labels = checkLabels(repo);
  return (
    <li className="grid gap-1.5 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="truncate font-mono">{repo.repository}</span>
        <PublicRepoMark repository={repo.repository} className="ml-0" />
        <span className="font-mono text-xs text-muted-foreground">{repo.path}</span>
      </div>
      {repo.error ? (
        <p className="flex gap-1.5 text-muted-foreground">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-run" />
          <span>
            The file is invalid, so the PR title check fails with this reason: {repo.error}
          </span>
        </p>
      ) : labels.length === 0 ? (
        <p className="text-muted-foreground">No checks on.</p>
      ) : (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {labels.map((label) => (
            <li key={label} className="flex items-center gap-1.5">
              <CircleCheck aria-hidden className="size-3.5 text-go" />
              {label}
            </li>
          ))}
        </ul>
      )}
      {repo.lint && !lintAvailable && (
        <p className="text-xs text-muted-foreground">
          Lint is in preview and isn't on for this account yet, so it doesn't run.
        </p>
      )}
    </li>
  );
}

type UsageState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; limits: RateLimits };

/**
 * How much of the installation's hourly GitHub API quota the App has used (#166). Loaded after the
 * page so a slow GitHub doesn't hold it up. Secondary limits aren't reported by GitHub at all.
 */
function ApiUsage({ installationId }: { installationId: number }) {
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    getRateLimits(installationId).then(
      (limits) => live && setState({ kind: "ready", limits }),
      () => live && setState({ kind: "error" }),
    );
    return () => {
      live = false;
    };
  }, [installationId]);

  if (state.kind === "loading")
    return <p className="text-xs text-muted-foreground">Reading GitHub API usage…</p>;
  if (state.kind === "error")
    return <p className="text-xs text-muted-foreground">Couldn't read GitHub API usage.</p>;
  const { core, graphql, actionsRunnerRegistration } = state.limits;
  return (
    <div className="grid gap-1.5 rounded-lg border bg-well px-3 py-2.5">
      {core && <UsageMeter label="REST API" bucket={core} />}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {graphql && <UsageFigure label="GraphQL" bucket={graphql} />}
        {actionsRunnerRegistration && (
          <UsageFigure label="Runner registrations" bucket={actionsRunnerRegistration} />
        )}
      </div>
    </div>
  );
}

const count = (n: number) => n.toLocaleString("en-US");

function UsageMeter({ label, bucket }: { label: string; bucket: RateLimitBucket }) {
  const share = bucket.limit ? Math.min(1, bucket.used / bucket.limit) : 0;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span>
          <span className="text-muted-foreground">{label} </span>
          <span className="font-mono tabular-nums">
            {count(bucket.used)} / {count(bucket.limit)}
          </span>
          <span className="text-muted-foreground"> this hour</span>
        </span>
        <span className="text-muted-foreground">{resetsIn(bucket.reset)}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} requests used this hour`}
        aria-valuemin={0}
        aria-valuemax={bucket.limit}
        aria-valuenow={bucket.used}
        className="h-1.5 overflow-hidden rounded-full bg-raised-2"
      >
        <div
          className={cn("h-full rounded-full", share >= 0.8 ? "bg-run" : "bg-go")}
          style={{ width: `${Math.max(share * 100, bucket.used ? 1 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function UsageFigure({ label, bucket }: { label: string; bucket: RateLimitBucket }) {
  return (
    <span>
      {label}{" "}
      <span className="font-mono text-foreground tabular-nums">
        {count(bucket.used)} / {count(bucket.limit)}
      </span>
    </span>
  );
}

function resetsIn(reset: string, now = Date.now()) {
  const minutes = Math.ceil((new Date(reset).getTime() - now) / 60_000);
  if (minutes <= 0) return "Resets now";
  return `Resets in ${minutes} min`;
}

function OrgName({ installation, children }: { installation: Installation; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="truncate font-mono">{installation.accountLogin}</span>
      <Badge variant="idle">{installation.accountType === "User" ? "Personal" : "Org"}</Badge>
      {children}
    </div>
  );
}

function SignInAgain() {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => signIn.social({ provider: "github", callbackURL: "/settings/github" })}
    >
      Sign in again
    </Button>
  );
}
