import { DEFAULT_RUNNER_ORDER, type RunnerKey, type RunnerStep } from "@relayrunner/runner-order";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BanIcon,
  CheckIcon,
  CloudIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LaptopIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  AddRunner,
  CONNECT_COMMAND,
  GithubIcon,
  GithubRunnersDialog,
  runnerSettingsUrl,
} from "@/components/add-runner";
import { DeviceBadge } from "@/components/device-badge";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authDisabled } from "@/lib/auth-client";
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
import { whereJobsGo } from "@/lib/where-jobs-go";

// How often the page refetches machines, so a machine connecting or going quiet shows up.
const REFRESH_MS = 15_000;

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

// The runners the workspace supplies, grouped as Self-hosted. Where jobs go is the Router's job;
// the line at the top says what it means right now.
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

  const editable = canManage(current.role);
  const machines = loaded.machines.filter((machine) => !machine.revokedAt);
  const status = whereJobsGo(loaded.order.steps, machines);

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

  const dialog = (
    <GithubRunnersDialog
      open={githubOpen}
      onOpenChange={setGithubOpen}
      onAdded={async () => {
        await router.invalidate();
        await findRunners();
      }}
    />
  );

  // No runners yet: the page is the pitch and the one command.
  if (machines.length === 0)
    return (
      <>
        {dialog}
        <ConnectLanding
          fallback={fallbackAfterMachine(loaded.order.steps)}
          found={found?.count ?? 0}
          onAddExisting={editable ? () => setGithubOpen(true) : undefined}
        />
      </>
    );

  return (
    <section>
      {dialog}
      <PageHeader
        title="Runners"
        action={<AddRunner onAddExisting={() => setGithubOpen(true)} />}
        wide
      >
        <span role="status">
          <span
            aria-hidden
            className={cn(
              "mr-2 inline-block size-2 rounded-full align-middle",
              status.tone === "go" ? "bg-go" : "bg-idle",
            )}
          />
          {status.text}{" "}
          <Link
            to="/router"
            className="inline-flex items-center gap-0.5 whitespace-nowrap text-go hover:text-go-hover"
          >
            Router
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </Link>
        </span>
      </PageHeader>
      <div className="grid max-w-5xl gap-6">
        <section aria-labelledby="self-hosted" className="grid gap-3">
          <h2 id="self-hosted" className="text-sm font-semibold">
            Self-hosted
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
            {machines.map((machine) => (
              <li key={machine.id} className="grid min-w-0">
                <MachineCard machine={machine} />
              </li>
            ))}
            {found && found.count > 0 && !dismissed && (
              <li className="grid min-w-0">
                <FoundCard
                  count={found.count}
                  orgs={found.orgs}
                  onReview={() => setGithubOpen(true)}
                  onDismiss={() => setDismissed(true)}
                />
              </li>
            )}
          </ul>
        </section>
      </div>
    </section>
  );
}

// Where a job goes when no self-hosted runner can take it: the first step after self-hosted.
function fallbackAfterMachine(steps: RunnerStep[]): RunnerKey | null {
  const at = steps.findIndex((step) => step.key === "machine");
  return steps.slice(at + 1).find((step) => step.key !== "machine")?.key ?? null;
}

// No runners yet: the whole page says what connecting does, then hands over the one command.
function ConnectLanding({
  fallback,
  found,
  onAddExisting,
}: {
  fallback: RunnerKey | null;
  /** Runners already on GitHub that could be added. */
  found: number;
  /** Missing for members, who can't add runners from GitHub. */
  onAddExisting?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(CONNECT_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the command is still there to select.
    }
  }
  const elsewhere =
    fallback === "github"
      ? { icon: <GithubIcon className="size-5" />, text: "Jobs go back to GitHub-hosted runners" }
      : fallback === "blacksmith"
        ? { icon: <CloudIcon aria-hidden className="size-5" />, text: "Jobs go back to Blacksmith" }
        : {
            icon: <CloudIcon aria-hidden className="size-5" />,
            text: "Jobs that need it stop early",
          };

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-8 py-4 sm:gap-10 sm:py-12">
      <div className="grid justify-items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          Run CI on your laptop while you work
        </h1>
        <p className="max-w-[54ch] text-pretty text-muted-foreground">
          Connect when you want private repo jobs on your own computer. Disconnect when you're done
          and they go back to where they ran before. Nothing has to stay on.
        </p>
      </div>

      <ol className="grid gap-3 sm:grid-cols-2" aria-label="How connecting works">
        <StatePanel
          on
          title="Connected"
          lines={[
            { prompt: true, text: CONNECT_COMMAND },
            { mark: "◆", text: "Online. Waiting for jobs.", go: true },
          ]}
          icon={<LaptopIcon aria-hidden className="size-5" />}
          text="Private repo jobs run on your laptop"
        />
        <StatePanel
          title="Disconnected"
          lines={[{ text: "^C" }, { mark: "└", text: "Offline." }]}
          icon={elsewhere.icon}
          text={elsewhere.text}
        />
      </ol>

      <div className="grid justify-items-center gap-3">
        <div className="flex w-full max-w-md items-center justify-between gap-3 rounded-md border bg-card py-2 pr-2 pl-4 font-mono text-sm">
          <span className="truncate">
            <span aria-hidden className="text-muted-foreground select-none">
              ${" "}
            </span>
            {CONNECT_COMMAND}
          </span>
          <Button size="sm" className="font-sans" onClick={() => void copy()}>
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Run it in a terminal on the computer you want CI on. It signs you in the first time.
        </p>
        {onAddExisting && (
          <Button variant="ghost" size="sm" className="mt-2" onClick={onAddExisting}>
            <GithubIcon />
            {found > 0
              ? `Add the ${found} self-hosted ${found === 1 ? "runner" : "runners"} already on GitHub`
              : "Already have a self-hosted runner? Add it"}
          </Button>
        )}
      </div>
    </section>
  );
}

function StatePanel({
  on = false,
  title,
  lines,
  icon,
  text,
}: {
  on?: boolean;
  title: string;
  lines: { prompt?: boolean; mark?: string; text: string; go?: boolean }[];
  icon: ReactNode;
  text: string;
}) {
  return (
    <li
      className={cn(
        "grid overflow-hidden rounded-lg border",
        on ? "border-go-edge bg-go-soft" : "bg-card",
      )}
    >
      <div className="flex items-center gap-2 px-4 pt-3.5 text-sm font-medium">
        <span aria-hidden className={cn("size-2 rounded-full", on ? "bg-go" : "bg-idle")} />
        {title}
      </div>
      <pre className="mx-4 mt-3 grid gap-1 rounded-md border bg-background px-3 py-2.5 font-mono text-xs leading-relaxed">
        {lines.map((line, i) => (
          <span key={i} className={cn(line.go ? "text-go" : "text-muted-foreground")}>
            {line.prompt ? <span className="select-none">$ </span> : null}
            {line.mark ? <span className="select-none">{line.mark} </span> : null}
            <span className={cn(line.prompt && "text-foreground")}>{line.text}</span>
          </span>
        ))}
      </pre>
      <div className="flex items-center gap-3 px-4 py-3.5 text-sm">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md border",
            on ? "border-go-edge text-go" : "text-muted-foreground",
          )}
        >
          {icon}
        </span>
        {text}
      </div>
    </li>
  );
}

// Runners already on GitHub that RelayRunner isn't using: a stub card beside the real ones.
function FoundCard({
  count,
  orgs,
  onReview,
  onDismiss,
}: {
  count: number;
  orgs: string[];
  onReview: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="flex flex-col justify-between gap-3 rounded-lg border border-dashed p-4">
      <div className="flex items-center gap-2.5">
        <GithubIcon className="text-muted-foreground" />
        <h3 className="flex-1 font-semibold">
          {count} {count === 1 ? "runner" : "runners"} on GitHub
        </h3>
        <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon aria-hidden />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        In <span className="font-mono">{orgs.join(", ")}</span>, not used by RelayRunner yet.
      </p>
      <div>
        <Button size="sm" variant="outline" onClick={onReview}>
          Review and add
        </Button>
      </div>
    </article>
  );
}

function MachineCard({ machine }: { machine: Machine }) {
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
      // Clipboard can be blocked; the labels are also on GitHub and in relay.yml.
    }
  }

  // Previews talk to the production API, which may not send status yet: read that as offline.
  const status = machine.status ?? { online: false, state: null, connectedAt: null };
  const paused = machine.paused ?? null;
  const missing = github?.missing ?? false;
  const live = missing
    ? { dot: "bg-destructive", label: "Not found on GitHub" }
    : paused
      ? { dot: "bg-run", label: status.online ? "Paused" : "Offline · Paused" }
      : status.online
        ? { dot: "bg-go", label: "Online" }
        : { dot: "bg-idle", label: "Offline" };
  const job = status.online && status.state === "busy" ? (machine.job ?? null) : null;
  // What the machine is doing, or why it isn't.
  const now = missing
    ? githubLine(github, paused, status)
    : paused
      ? pausedLine(paused, status)
      : status.online
        ? status.state === "busy"
          ? "Running a job"
          : "Waiting for a job"
        : isGithub
          ? githubLine(github, paused, status) || "Offline on GitHub"
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
    <article
      aria-label={machine.name}
      className={cn(
        "grid content-start gap-3 rounded-lg border p-4",
        status.online && !missing ? "bg-card" : "bg-background",
        paused && "border-run-edge/60",
        missing && "border-destructive/50 bg-destructive/5",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate font-mono text-[15px] font-medium">{machine.name}</h3>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={cn(
              "mr-1 flex items-center gap-1.5 text-sm",
              status.online ? "text-foreground" : "text-muted-foreground",
              missing && "text-destructive",
            )}
          >
            <span aria-hidden className={cn("size-2 rounded-full", live.dot)} />
            {live.label}
          </span>
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
              {/* Resuming is the one thing a paused machine needs, so it gets a button. */}
              {paused && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void act("resume")}
                >
                  <PlayIcon aria-hidden />
                  {pending === "resume" ? "Resuming…" : "Resume"}
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
                      <span className="grid">
                        <span>Copy labels</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {machine.labels.join(", ")}
                        </span>
                      </span>
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
        </div>
      </div>

      <div className="-mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {isGithub ? (
          <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
            <GithubIcon className="size-3" />
            GitHub runner
          </Badge>
        ) : (
          machine.device && <DeviceBadge device={machine.device} />
        )}
        {machine.owner && <span className="truncate">{machine.owner}</span>}
      </div>

      <div
        className={cn(
          "rounded-md bg-background px-3 py-2 text-sm",
          job ? "text-foreground" : "text-muted-foreground",
          missing && "text-destructive",
        )}
      >
        {job ? (
          <a href={job.url} target="_blank" rel="noreferrer" className="hover:underline">
            Running {job.repository} · {job.name}
            {job.startedAt && (
              <span className="text-muted-foreground"> · started {timeAgo(job.startedAt)}</span>
            )}
          </a>
        ) : (
          now
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </article>
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
