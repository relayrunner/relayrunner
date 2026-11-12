import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { LaptopIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Brand } from "@/components/brand";
import { BlacksmithIcon, GithubIcon } from "@/components/provider-logos";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { authDisabled, organization } from "@/lib/auth-client";
import { signOut } from "@/lib/session";
import {
  githubInstallHref,
  githubOutcomes,
  isGitHubOutcome,
  type GitHubOutcome,
} from "@/lib/github";
import { listMyMachines, type Machine } from "@/lib/machines";
import { cn } from "@/lib/utils";
import { usePageTitle } from "@/lib/page-title";

// Signed in, but no workspace yet (#320). Installing the GitHub App on an account or org is what
// makes a workspace (#316), so this page points there. An install on an org by someone who isn't
// its owner waits for an owner to approve it, and this is where they wait. The page leads with what
// RelayRunner does for a job, so the install has a reason; a machine they've already connected
// (#318) stands in for "your laptop".
export const Route = createFileRoute("/_authed/welcome")({
  validateSearch: (search: Record<string, unknown>): { github?: GitHubOutcome } => ({
    github: isGitHubOutcome(search.github) ? search.github : undefined,
  }),
  beforeLoad: async () => {
    if (authDisabled) return;
    // An install landed since (an owner approved it, say): go to it.
    const { data } = await organization.list();
    if (data?.length) throw redirect({ to: "/runners" });
  },
  loader: async (): Promise<Machine[]> =>
    authDisabled ? sampleMachines : (await listMyMachines()).machines,
  component: WelcomePage,
});

function WelcomePage() {
  usePageTitle("Welcome");
  const { github } = Route.useSearch();
  const machines = Route.useLoaderData();
  const router = useRouter();
  const requested = github === "requested";

  async function handleSignOut() {
    await signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <Brand />
        <div className="grid w-full gap-6">
          <div className="grid gap-2 text-center">
            <h1 className="text-[26px] leading-tight font-bold tracking-[-0.02em] text-balance">
              {requested ? "Waiting on an org owner" : "Your next CI job could run here."}
            </h1>
            <p className="text-balance text-muted-foreground">
              {requested
                ? githubOutcomes.requested.message
                : "Install the GitHub App and RelayRunner picks a runner for every job."}
            </p>
          </div>

          <RoutePreview machine={machines[0]} />

          <div className="grid gap-3">
            {github && !requested && (
              <p role="status" className="rounded-lg border bg-well px-3 py-2 text-sm">
                {githubOutcomes[github].message}
              </p>
            )}
            <Button asChild size="lg" className="w-full font-bold">
              {/* A full page load: this leaves the dashboard for GitHub's install page. */}
              <a href={githubInstallHref()}>
                <GithubIcon className="size-[18px]" />
                {requested ? "Install on another account" : "Install on GitHub"}
              </a>
            </Button>
            {!requested && (
              <p className="text-center text-xs text-muted-foreground">
                Asked an org owner to approve? It shows up here once they do.
              </p>
            )}
          </div>
        </div>

        {!authDisabled && (
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        )}
      </div>
    </main>
  );
}

// One job's route, as RelayRunner would pick it: the person's own machine (named, if they've
// connected one), with GitHub-hosted and Blacksmith behind it.
function RoutePreview({ machine }: { machine?: Machine }) {
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-label="Example: where a job runs">
      <div className="flex items-center gap-2 border-b px-4 py-3 font-mono text-xs text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-run" />
        ci / test · PR #482
      </div>
      <ol className="grid gap-2 p-3">
        <Lane
          active
          icon={<LaptopIcon className="size-4" />}
          title={machine?.name ?? "Your laptop"}
          meta="Free while it's online"
          tag="Runs it"
        />
        <Lane
          icon={<GithubIcon className="size-4" />}
          title="GitHub-hosted"
          meta="When your laptop is off"
          tag="Fallback"
        />
        <Lane
          icon={<BlacksmithIcon className="w-4" />}
          title="Blacksmith"
          meta="Optional"
          tag="Fallback"
        />
      </ol>
    </Card>
  );
}

function Lane({
  icon,
  title,
  meta,
  tag,
  active,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  tag: string;
  active?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm",
        active ? "border-go-edge bg-go-soft" : "opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-md bg-well",
          active && "text-go",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{meta}</span>
      </span>
      <span
        className={cn(
          "shrink-0 text-xs font-semibold",
          active ? "text-go" : "text-muted-foreground",
        )}
      >
        {tag}
      </span>
    </li>
  );
}

// For the `VITE_AUTH_DISABLED=true` dev preview.
const sampleMachines: Machine[] = [
  {
    id: "sample-mbp",
    name: "studio-mbp",
    os: "macos",
    arch: "arm64",
    lastSeenAt: null,
    revokedAt: null,
    createdAt: new Date(0).toISOString(),
    status: { online: true, state: "idle", connectedAt: null },
  },
];
