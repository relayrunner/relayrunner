import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ActionsMinutes, OverageBanner } from "@/components/actions-minutes";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type AccountUsage,
  type ActionsUsage,
  getActionsUsage,
  sampleActionsUsage,
} from "@/lib/actions-usage";
import { ApiError } from "@/lib/api";
import { authDisabled, signIn } from "@/lib/auth-client";
import { canManage } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { githubOutcomes as outcomes, isGitHubOutcome, type GitHubOutcome } from "@/lib/github";
import {
  claimInstallation,
  getRateLimits,
  getUnclaimedInstallations,
  needsGitHubSignIn,
  type Installation,
  type RateLimitBucket,
  type RateLimits,
  type UnclaimedInstallations,
} from "@/lib/workspace";

export const Route = createFileRoute("/_authed/_workspace/settings/github")({
  validateSearch: (search: Record<string, unknown>): { github?: GitHubOutcome } => ({
    github: isGitHubOutcome(search.github) ? search.github : undefined,
  }),
  // Only owners and admins can claim, so members skip the GitHub lookup.
  loader: ({ context }): Promise<UnclaimedInstallations> =>
    authDisabled || !canManage(context.current.role)
      ? Promise.resolve({ installations: [] })
      : getUnclaimedInstallations(),
  component: GitHubSettingsPage,
});

function GitHubSettingsPage() {
  const { current } = Route.useRouteContext();
  const { github } = Route.useSearch();
  const unclaimed = Route.useLoaderData();
  const { workspace } = current;
  const manager = canManage(current.role);
  const minutes = useActionsUsage();
  // Previews without an API show the sample accounts as connected orgs.
  const installations =
    authDisabled && current.installations.length === 0
      ? sampleInstallations(minutes)
      : current.installations;

  return (
    <section>
      <PageHeader title="GitHub orgs">
        The GitHub orgs and accounts whose jobs this workspace routes.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        {github && <GitHubNotice outcome={github} />}
        {minutes && <OverageBanner accounts={minutes.accounts} />}

        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Connected</CardTitle>
            <CardDescription>
              Where the RelayRunner GitHub App is installed for {workspace.name}.
              {!manager && " Owners and admins connect GitHub orgs."}
            </CardDescription>
            {manager && (
              <CardAction>
                <Button asChild size="sm" variant={installations.length ? "outline" : "default"}>
                  {/* A full page load: this leaves the dashboard for GitHub's install page. GitHub
                    lists only accounts that can take a new install; with none left it opens the
                    existing installation's settings instead. */}
                  <a href="/api/github/install">
                    {installations.length ? "Connect another org" : "Connect GitHub org"}
                  </a>
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="px-4">
            {installations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No GitHub orgs connected yet.</p>
            ) : (
              <ul className="grid gap-5">
                {installations.map((installation) => (
                  <ConnectedOrg
                    key={installation.id}
                    installation={installation}
                    minutes={minutes?.accounts.find((a) => a.installationId === installation.id)}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {manager && (
          <UnclaimedCard
            workspaceName={workspace.name}
            unclaimed={unclaimed}
            // The notice above already has a sign-in prompt.
            hideSignIn={github === "reauth"}
          />
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

/** Each account's Actions minutes this month, loaded after the page. Null until read, or on error. */
function useActionsUsage() {
  const [usage, setUsage] = useState<ActionsUsage | null>(null);
  useEffect(() => {
    if (authDisabled) return setUsage(sampleActionsUsage());
    let live = true;
    getActionsUsage().then(
      (read) => live && setUsage(read),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return usage;
}

function sampleInstallations(usage: ActionsUsage | null): Installation[] {
  return (usage?.accounts ?? []).map((account) => ({
    id: account.installationId,
    accountLogin: account.accountLogin,
    accountType: account.accountType,
    repositorySelection: "all",
    suspendedAt: null,
    settingsUrl: `https://github.com/organizations/${account.accountLogin}/settings/installations`,
  }));
}

function ConnectedOrg({
  installation,
  minutes,
}: {
  installation: Installation;
  minutes?: AccountUsage;
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
              aria-label={`${suspendedAt ? "Fix" : "Configure"} ${accountLogin} on GitHub`}
            >
              {suspendedAt ? "Fix" : "Configure"}
              <ExternalLink aria-hidden />
            </a>
          </Button>
        </div>
      </div>
      {/* A suspended installation can't get a token, so there's nothing to read. */}
      {minutes && <ActionsMinutes usage={minutes} />}
      {!suspendedAt && <ApiUsage installationId={installation.id} />}
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
    if (authDisabled) return setState({ kind: "error" });
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

function UnclaimedCard({
  workspaceName,
  unclaimed,
  hideSignIn,
}: {
  workspaceName: string;
  unclaimed: UnclaimedInstallations;
  hideSignIn: boolean;
}) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const [claiming, setClaiming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  async function claim(id: number) {
    setClaiming(id);
    setError(null);
    try {
      await claimInstallation(id);
      // Drop any ?github= notice: it was about getting this installation linked.
      await navigate({ search: {}, replace: true });
      await router.invalidate();
    } catch (cause) {
      if (needsGitHubSignIn(cause)) setExpired(true);
      else setError(claimErrorMessage(cause));
    } finally {
      setClaiming(null);
    }
  }

  const needsSignIn = (unclaimed.problem === "reauth" || expired) && !hideSignIn;
  const unavailable = unclaimed.problem === "unavailable";
  if (unclaimed.installations.length === 0 && !needsSignIn && !unavailable) return null;

  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Unclaimed installations</CardTitle>
        <CardDescription>
          GitHub App installs your account can see that aren't in a workspace yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-4 text-sm">
        {unclaimed.installations.length > 0 && (
          <ul className="grid gap-3">
            {unclaimed.installations.map((installation) => (
              <li
                key={installation.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5"
              >
                <OrgName installation={installation} />
                <Button
                  variant="outline"
                  size="xs"
                  disabled={claiming !== null}
                  onClick={() => claim(installation.id)}
                >
                  {claiming === installation.id ? "Adding…" : `Add to ${workspaceName}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {needsSignIn && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="min-w-0 flex-1 basis-60 text-muted-foreground">
              Your GitHub sign-in has expired. Sign in again to see your installations.
            </p>
            <SignInAgain />
          </div>
        )}
        {unavailable && (
          <p className="text-muted-foreground">
            Couldn't reach GitHub to check. Reload to try again.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function claimErrorMessage(error: unknown) {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === "installation_in_another_workspace")
    return "That GitHub org is already connected to another workspace.";
  if (code === "not_found") return "Your GitHub account can no longer see that installation.";
  if (code === "forbidden") return "Only workspace owners and admins can add GitHub orgs.";
  return "Couldn't add that installation. Try again.";
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
