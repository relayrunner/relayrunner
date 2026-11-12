import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

// Signed in, but no workspace yet (#320). Installing the GitHub App on an account or org is what
// makes a workspace (#316), so this page points there. An install on an org by someone who isn't
// its owner waits for an owner to approve it, and this is where they wait. Their machines already
// belong to them (#318), so they're listed too.
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
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        <Brand />
        <Card className="w-full">
          <CardHeader>
            <CardTitle>{requested ? "Waiting on an org owner" : "No workspace yet"}</CardTitle>
            <CardDescription>
              {requested
                ? githubOutcomes.requested.message
                : "Each GitHub account or org with the RelayRunner App installed is a workspace. Install it on one to get started. If you asked an org owner to approve an install, it shows up here once they do."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {github && !requested && (
              <p role="status" className="rounded-lg border bg-well px-3 py-2 text-sm">
                {githubOutcomes[github].message}
              </p>
            )}
            <Button asChild size="lg" className="w-full font-bold">
              {/* A full page load: this leaves the dashboard for GitHub's install page. */}
              <a href={githubInstallHref()}>
                {requested ? "Install on another account" : "Install on GitHub"}
              </a>
            </Button>
          </CardContent>
        </Card>

        <Card className="w-full py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">
              Your machines{" "}
              <span className="font-normal text-muted-foreground">{machines.length}</span>
            </CardTitle>
            <CardDescription>
              They're yours, and they join every workspace you're in. Connect one with{" "}
              <code className="font-mono text-foreground">npx relayrunner connect</code>.
            </CardDescription>
          </CardHeader>
          {machines.length > 0 && (
            <CardContent className="px-4">
              <ul className="grid divide-y">
                {machines.map((machine) => (
                  <MachineRow key={machine.id} machine={machine} />
                ))}
              </ul>
            </CardContent>
          )}
        </Card>

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

const osNames = { macos: "macOS", linux: "Linux", windows: "Windows" } as const;

function MachineRow({ machine }: { machine: Machine }) {
  const online = machine.status?.online ?? false;
  const details = [
    machine.device?.model ?? (machine.os ? osNames[machine.os] : null),
    machine.paused ? "Paused" : online ? "Online" : "Offline",
  ].filter(Boolean);
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          machine.paused ? "bg-run" : online ? "bg-go" : "bg-[var(--rr-idle)]",
        )}
      />
      <span className="min-w-0 flex-1 truncate font-medium">{machine.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{details.join(" · ")}</span>
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
