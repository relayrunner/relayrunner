import { DEFAULT_RUNNER_ORDER, type RunnerKey } from "@relayrunner/runner-order";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  AddRunner,
  GithubIcon,
  GithubRunnersDialog,
  runnerSettingsUrl,
} from "@/components/add-runner";
import { DeviceBadge } from "@/components/device-badge";
import { RunnerOrderEditor } from "@/components/runner-order-editor";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authDisabled } from "@/lib/auth-client";
import { getMachineJobTimes, medianText, plural, type Stat } from "@/lib/job-times";
import {
  addableRunners,
  listGithubRunners,
  listMachines,
  pauseMachine,
  resumeMachine,
  revokeMachine,
  timeAgo,
  type Machine,
} from "@/lib/machines";
import { canManage } from "@/lib/roles";
import { getRunnerOrder } from "@/lib/runner-order";
import { cn } from "@/lib/utils";

// How often the page refetches machines, so a machine connecting or going quiet shows up.
const REFRESH_MS = 15_000;

const machineBadge = {
  idle: { variant: "go", label: "Online · Idle" },
  busy: { variant: "run", label: "Online · Busy" },
  offline: { variant: "idle", label: "Offline" },
} as const;

export const Route = createFileRoute("/_authed/_workspace/runners")({
  loader: async ({ context }) => {
    try {
      const [order, { machines }] = await Promise.all([
        getRunnerOrder(context.current.workspace.id),
        listMachines(),
      ]);
      return { ...order, machines };
    } catch (error) {
      // The dev preview has no API behind it.
      if (authDisabled) return { order: DEFAULT_RUNNER_ORDER, isDefault: true, machines: [] };
      throw error;
    }
  },
  component: RunnersPage,
});

// The page is the runner order (RunnerOrderEditor), with each provider's runners in its section.
function RunnersPage() {
  const loaded = Route.useLoaderData();
  const { current } = Route.useRouteContext();
  const router = useRouter();
  useEffect(() => {
    if (authDisabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void router.invalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  // Owners and admins change the order (#134); members read it. The API refuses a member's save.
  const editable = canManage(current.role);

  const body = (key: RunnerKey) =>
    key === "machine" ? <MachineList machines={loaded.machines} /> : null;

  // Runners in connected orgs that aren't added yet, for the banner. Owners and admins only, since
  // only they can add them; read once per visit, not on every refresh, since it asks GitHub.
  const [githubOpen, setGithubOpen] = useState(false);
  const [found, setFound] = useState<{ count: number; orgs: string[] } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  async function findRunners() {
    if (!editable) return;
    try {
      const { orgs } = await listGithubRunners();
      const addable = addableRunners(orgs);
      const withRunners = orgs.filter(
        (org) => "runners" in org && org.runners.some((r) => !r.machineId && !r.blocked),
      );
      setFound({ count: addable.length, orgs: withRunners.map((org) => org.org) });
    } catch {
      setFound(null);
    }
  }
  useEffect(() => {
    void findRunners();
    // Once per visit and workspace.
  }, [current.workspace.id, editable]);

  return (
    <section>
      <GithubRunnersDialog
        open={githubOpen}
        onOpenChange={setGithubOpen}
        onAdded={async () => {
          await router.invalidate();
          await findRunners();
        }}
      />
      <PageHeader title="Runners" action={<AddRunner onAddExisting={() => setGithubOpen(true)} />}>
        Jobs try these providers from top to bottom.{" "}
        {editable
          ? "Move a section to change the order."
          : "Owners and admins can change the order."}
      </PageHeader>
      <div className="grid max-w-3xl gap-3">
        {found && found.count > 0 && !dismissed && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-go-edge bg-go-soft px-4 py-3">
            <SearchIcon aria-hidden className="size-4 shrink-0 text-go" />
            <p className="min-w-0 flex-1 text-sm">
              We found{" "}
              <strong>
                {found.count} self-hosted {found.count === 1 ? "runner" : "runners"}
              </strong>{" "}
              in <span className="font-mono">{found.orgs.join(", ")}</span> that RelayRunner isn't
              using yet.
            </p>
            <Button size="sm" variant="outline" onClick={() => setGithubOpen(true)}>
              Review
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        )}
        <RunnerOrderEditor
          workspaceId={current.workspace.id}
          order={loaded.order}
          isDefault={loaded.isDefault}
          editable={editable}
          meta={(key) => meta(key, loaded.machines)}
          body={body}
        />
      </div>
    </section>
  );
}

function meta(key: RunnerKey, machines: Machine[]) {
  if (key === "github") return "Runs on the label the job sets in relay.yml's github input.";
  if (key === "blacksmith")
    return "Runs on the label the job sets in relay.yml's blacksmith input · needs Blacksmith's GitHub App on the org";
  const active = machines.filter((machine) => !machine.revokedAt);
  const count = active.length;
  const paused = active.filter((machine) => machine.paused).length;
  return `${count} ${count === 1 ? "machine" : "machines"}${paused ? ` · ${paused} paused` : ""} · spread by least recently picked · never for public repos`;
}

function MachineList({ machines }: { machines: Machine[] }) {
  if (machines.length === 0) {
    return (
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm font-medium">No machines yet</CardTitle>
          <CardDescription>
            Run <code className="font-mono">npx relayrunner connect</code> on a laptop or server to
            add it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <MachineCards machines={machines} />;
}

// Each machine's typical job over the last 14 days, loaded after the cards so they never wait on it.
function MachineCards({ machines }: { machines: Machine[] }) {
  const [jobTimes, setJobTimes] = useState<Record<string, Stat>>({});
  useEffect(() => {
    if (authDisabled) return;
    let live = true;
    getMachineJobTimes()
      .then((result) => live && setJobTimes(result.machines))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return machines.map((machine) => (
    <MachineCard key={machine.id} machine={machine} jobTime={jobTimes[machine.id]} />
  ));
}

function MachineCard({ machine, jobTime }: { machine: Machine; jobTime?: Stat }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<"revoke" | "pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A self-hosted runner added from GitHub: no connection of its own, removed rather than revoked.
  const github = machine.source === "github" ? (machine.github ?? null) : null;
  const isGithub = machine.source === "github";

  async function act(action: "revoke" | "pause" | "resume") {
    setPending(action);
    setError(null);
    try {
      if (action === "revoke") await revokeMachine(machine.id);
      else if (action === "pause") await pauseMachine(machine.id);
      else await resumeMachine(machine.id);
      await router.invalidate();
      if (action !== "revoke") setPending(null);
    } catch {
      setError(
        action === "revoke" && github
          ? "Couldn't remove the runner. Try again."
          : `Couldn't ${action} the machine. Try again.`,
      );
      setPending(null);
    }
  }

  async function copyLabels() {
    try {
      await navigator.clipboard.writeText((machine.labels ?? []).join(", "));
    } catch {
      // Clipboard can be blocked; the chips are still readable and copy one at a time.
    }
  }

  // Previews talk to the production API, which may not send status yet: read that as offline.
  const status = machine.status ?? { online: false, state: null, connectedAt: null };
  const paused = machine.paused ?? null;
  const missing = github?.missing ?? false;
  const live = missing
    ? ({ variant: "outline", label: "Not found on GitHub" } as const)
    : paused
      ? pausedBadge(status)
      : machineBadge[status.online ? (status.state ?? "idle") : "offline"];
  const seen = isGithub
    ? githubLine(github, paused, status)
    : paused
      ? pausedLine(paused, status)
      : status.online
        ? status.connectedAt && `Connected ${timeAgo(status.connectedAt)}`
        : machine.lastSeenAt
          ? `Last seen ${timeAgo(machine.lastSeenAt)}`
          : "Never connected";
  const githubUrl =
    github?.org && github.runnerId
      ? `${runnerSettingsUrl(github.org)}/${github.runnerId}`
      : github?.org
        ? runnerSettingsUrl(github.org)
        : null;

  return (
    <Card
      className={cn(
        "py-4",
        paused && "border-run-edge/60",
        missing && "border-destructive/50 bg-destructive/5",
      )}
    >
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 self-center">
          <span className="font-mono text-sm font-medium">{machine.name}</span>
          {isGithub && (
            <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
              <GithubIcon className="size-3" />
              GitHub runner
            </Badge>
          )}
          {!isGithub && machine.device && <DeviceBadge device={machine.device} />}
        </CardTitle>
        {/* Full width under the name and the actions, so a long paused line fits on a phone. */}
        <CardDescription className="col-span-2">
          {seen || "Your machine"}
          {jobTime && jobTime.samples > 0 && (
            <span className="block tabular-nums">
              Typical job {medianText(jobTime)} ·{" "}
              <Link to="/job-times" className="underline-offset-4 hover:underline">
                {plural(jobTime.samples, "run")} in 14 days
              </Link>
            </span>
          )}
          {error && <span className="block text-destructive">{error}</span>}
        </CardDescription>
        <CardAction className="row-span-1 flex items-center gap-2">
          <Badge
            variant={live.variant}
            className={cn(missing && "border-destructive/60 text-destructive")}
          >
            {live.label}
          </Badge>
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={pending !== null}
                onClick={() => void act("revoke")}
              >
                {pending === "revoke"
                  ? isGithub
                    ? "Removing…"
                    : "Revoking…"
                  : isGithub
                    ? "Remove"
                    : "Revoke"}
              </Button>
            </>
          ) : (
            <>
              {/* Pausing is rare and lives in the menu; resuming is the one thing a paused
                  machine needs, so it gets the button. */}
              {paused && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void act("resume")}
                >
                  <PlayIcon aria-hidden />
                  {/* Icon only on a phone, so the badge and the name keep their room. */}
                  <span className="sr-only sm:not-sr-only">
                    {pending === "resume" ? "Resuming…" : "Resume"}
                  </span>
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`More actions for ${machine.name}`}
                    disabled={pending !== null}
                  >
                    <EllipsisIcon aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {paused ? (
                    <DropdownMenuItem onSelect={() => void act("resume")}>
                      <PlayIcon aria-hidden />
                      Resume
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => void act("pause")}>
                      <PauseIcon aria-hidden />
                      <span className="grid">
                        <span>Pause</span>
                        <span className="text-xs text-muted-foreground">
                          Stay connected, skip new jobs
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {machine.labels && machine.labels.length > 0 && (
                    <DropdownMenuItem onSelect={() => void copyLabels()}>
                      <CopyIcon aria-hidden />
                      Copy labels
                    </DropdownMenuItem>
                  )}
                  {githubUrl && (
                    <DropdownMenuItem asChild>
                      <a href={githubUrl} target="_blank" rel="noreferrer">
                        <ExternalLinkIcon aria-hidden />
                        View on GitHub
                      </a>
                    </DropdownMenuItem>
                  )}
                  {/* Members revoke only the machines they enrolled; the API says which. */}
                  {machine.canRevoke !== false && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                        <BanIcon aria-hidden />
                        {isGithub ? (
                          <span className="grid">
                            <span>Remove from RelayRunner…</span>
                            <span className="text-xs text-muted-foreground">
                              Stays registered on GitHub
                            </span>
                          </span>
                        ) : (
                          "Revoke…"
                        )}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </CardAction>
        {/* Full width under the name and the actions, so the chips have room on a phone. */}
        {machine.labels && machine.labels.length > 0 && (
          <MachineLabels
            labels={machine.labels}
            routingLabel={machine.routingLabel ?? null}
            dimmed={paused !== null || missing}
          />
        )}
      </CardHeader>
    </Card>
  );
}

// What a GitHub runner's line says: why jobs skip it, or where it lives and what its group allows.
function githubLine(
  github: Machine["github"] | null,
  paused: { at: string; by: string | null } | null,
  status: { online: boolean; state: "idle" | "busy" | null },
) {
  if (github?.missing)
    return "It was removed or re-registered on GitHub, so jobs skip it. If it was re-registered, add it again.";
  if (paused) return pausedLine(paused, status);
  if (github?.unreachable) return "Couldn't reach GitHub for its status";
  return [github?.org && `In ${github.org}`, github?.access].filter(Boolean).join(" · ");
}

// A paused machine's badge: still online or not, and whether it's finishing a job.
function pausedBadge(status: { online: boolean; state: "idle" | "busy" | null }) {
  if (!status.online) return { variant: "paused", label: "Offline · Paused" } as const;
  if (status.state === "busy")
    return { variant: "paused", label: "Paused · Finishing job" } as const;
  return { variant: "paused", label: "Online · Paused" } as const;
}

function pausedLine(
  paused: { at: string; by: string | null },
  status: { online: boolean; state: "idle" | "busy" | null },
) {
  const who = paused.by ? `Paused by ${paused.by}` : "Paused from its CLI";
  const then =
    status.online && status.state === "busy"
      ? "finishing its job, then no new jobs"
      : "jobs skip it until it's resumed";
  return `${who} ${timeAgo(paused.at)} · ${then}`;
}

// The labels a job's `machine:` input matches. Clicking one copies it.
function MachineLabels({
  labels,
  routingLabel = null,
  dimmed = false,
}: {
  labels: string[];
  /** RelayRunner's own label on a GitHub runner, shown dashed so it reads as ours. */
  routingLabel?: string | null;
  dimmed?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string) {
    try {
      await navigator.clipboard.writeText(label);
      setCopied(label);
      setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); the label is still readable.
    }
  }

  return (
    <ul
      className={cn("col-span-2 flex flex-wrap items-center gap-1.5", dimmed && "opacity-60")}
      aria-label="Labels"
    >
      {labels.map((label) => (
        <li key={label} className="flex">
          <Badge asChild variant="outline" className="font-mono font-normal">
            <button
              type="button"
              className="cursor-pointer hover:bg-accent hover:text-accent-foreground"
              title="Copy label"
              aria-label={copied === label ? `Copied ${label}` : `Copy ${label}`}
              onClick={() => void copy(label)}
            >
              {copied === label && <CheckIcon />}
              {label}
            </button>
          </Badge>
        </li>
      ))}
      {routingLabel && (
        <li className="flex">
          <Badge
            variant="outline"
            className="border-dashed font-mono font-normal text-muted-foreground"
            title="Added by RelayRunner to route jobs to this runner"
          >
            {routingLabel}
          </Badge>
        </li>
      )}
    </ul>
  );
}
