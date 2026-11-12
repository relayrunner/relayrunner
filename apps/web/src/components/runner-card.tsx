import { Link, useRouter } from "@tanstack/react-router";
import {
  BanIcon,
  BoxIcon,
  CopyIcon,
  CpuIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LaptopIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  ServerIcon,
  TimerIcon,
  XIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { runnerSettingsUrl } from "@/components/add-runner";
import { GithubIcon } from "@/components/provider-logos";
import { type Provider, providerStyle, runnerName, TILE } from "@/components/providers";
import { SHARING_ICONS, SharingDialog, sharingLabel } from "@/components/machine-sharing";
import { UserAvatar } from "@/components/workspace-menu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deviceName, formatMemory, type DeviceKind } from "@/lib/device";
import { medianText, plural, type EnvironmentSummary, type Stat } from "@/lib/job-times";
import {
  machineAccess,
  pauseMachine,
  resumeMachine,
  revokeMachine,
  timeAgo,
  type Machine,
  type MachineJob,
} from "@/lib/machines";
import { capacity } from "@/lib/capacity";
import { cn } from "@/lib/utils";

const KIND_ICONS: Record<DeviceKind, LucideIcon> = {
  laptop: LaptopIcon,
  desktop: MonitorIcon,
  server: ServerIcon,
  vm: BoxIcon,
  unknown: CpuIcon,
};

const OS_NAMES = { linux: "Linux", macos: "macOS", windows: "Windows" } as const;
const ARCH_NAMES = { x64: "x64", arm64: "ARM64", arm: "ARM" } as const;

// The card's bottom band is about jobs. Online states share one neutral band; only offline and
// missing change it, since those are the ones that need noticing.
const BANDS = {
  running: { band: "bg-raised-2", label: "text-foreground", dot: "hidden" },
  idle: { band: "bg-raised-2", label: "text-muted-foreground", dot: "hidden" },
  paused: { band: "bg-raised-2", label: "text-run", dot: "hidden" },
  offline: {
    band: "bg-well",
    label: "text-muted-foreground",
    dot: "border-2 border-idle bg-transparent",
  },
  missing: { band: "bg-destructive/10", label: "text-destructive", dot: "bg-destructive" },
} as const;

// Connection status, as a dot on the icon.
const CONNECTION = {
  online: { dot: "bg-go", label: "Online" },
  offline: { dot: "border-2 border-idle bg-transparent", label: "Offline" },
  paused: { dot: "bg-run", label: "Paused" },
  missing: { dot: "bg-destructive", label: "Not on GitHub" },
} as const;

/**
 * A square chip with an icon, named by a tooltip. `session` marks a `relayrunner connect` machine,
 * which comes and goes with its terminal: a bolt stands in for the dot, filled while connected.
 */
function IconChip({
  icon,
  label,
  status,
  session = false,
}: {
  icon: ReactNode;
  label: string;
  status?: { dot: string; label: string };
  session?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex size-6 shrink-0 cursor-default items-center justify-center rounded-md bg-raised-2 text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="relative flex">
            {icon}
            {status?.label === "Paused" ? (
              <span
                role="img"
                aria-label={status.label}
                className="absolute -right-1.5 -bottom-1.5 flex size-3 items-center justify-center rounded-full bg-raised-2 text-run"
              >
                <PauseIcon aria-hidden className="size-2.5 fill-current" strokeWidth={0} />
              </span>
            ) : session && status ? (
              <span
                role="img"
                aria-label={status.label}
                className={cn(
                  "absolute -right-[7px] -bottom-[7px] flex size-3.5 items-center justify-center rounded-full bg-raised-2",
                  status.label === "Online" ? "text-go" : "text-idle",
                )}
              >
                <ZapIcon
                  aria-hidden
                  className={cn("size-2.5", status.label === "Online" && "fill-current")}
                  strokeWidth={status.label === "Online" ? 1 : 2.25}
                />
              </span>
            ) : (
              status && (
                <span
                  role="img"
                  aria-label={status.label}
                  className={cn(
                    "absolute -right-1 -bottom-1 size-2 rounded-full ring-2 ring-raised-2",
                    status.dot,
                    status.label === "Offline" && "bg-raised-2",
                  )}
                />
              )
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function Card({
  children,
  dim,
  className,
  label,
}: {
  children: ReactNode;
  dim?: boolean;
  className?: string;
  label: string;
}) {
  return (
    <article
      aria-label={label}
      className={cn(
        "group/card flex min-w-0 flex-col overflow-hidden rounded-xl border",
        dim ? "bg-dormant" : "bg-card",
        className,
      )}
    >
      {children}
    </article>
  );
}

function Band({ tone, children }: { tone: keyof typeof BANDS; children: ReactNode }) {
  return (
    <div
      className={cn(
        "mt-auto flex min-h-10 min-w-0 items-center justify-between gap-3 px-4 py-2 text-xs",
        BANDS[tone].band,
      )}
    >
      {children}
    </div>
  );
}

function BandLabel({ tone, children }: { tone: keyof typeof BANDS; children: ReactNode }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-2 font-semibold", BANDS[tone].label)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", BANDS[tone].dot)} />
      {children}
    </span>
  );
}

// One labeled fact in the card's grid.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 text-ink-2 tabular-nums">{children}</dd>
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="truncate">{children}</span>;
}

// The other jobs a busy machine is running, behind a +N chip next to the newest.
function MoreJobs({ jobs }: { jobs: MachineJob[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-full border border-current/25 px-1.5 text-[11px] leading-4 font-medium tabular-nums text-ink-2 hover:bg-current/10"
          aria-label={`${plural(jobs.length, "more job")} running`}
        >
          +{jobs.length}
        </button>
      </TooltipTrigger>
      <TooltipContent align="end" className="grid max-w-80 gap-1.5 py-2">
        {jobs.map((job) => (
          <a
            key={job.url}
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-baseline gap-2 hover:underline"
          >
            <span className="min-w-0 truncate">
              {job.repository} · {job.name}
            </span>
            {job.startedAt && <span className="shrink-0 opacity-70">{timeAgo(job.startedAt)}</span>}
          </a>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

// A spec the machine didn't report, such as a runner added from GitHub's CPU and memory.
function NotReported() {
  return (
    <span className="text-idle">
      <span aria-hidden>—</span>
      <span className="sr-only">Not reported</span>
    </span>
  );
}

export function MachineCard({
  machine,
  jobTime,
  specs = false,
}: {
  machine: Machine;
  jobTime?: Stat;
  /** Show the hardware and typical job. Off by default to keep the cards simple. */
  specs?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [pending, setPending] = useState<"revoke" | "pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A self-hosted runner added from GitHub: no connection of its own, removed rather than revoked.
  const isGithub = machine.source === "github";
  const github = isGithub ? (machine.github ?? null) : null;
  // The runner's group access, read from GitHub the first time its menu opens (several calls).
  // undefined: not asked yet.
  const [access, setAccess] = useState<string | null | undefined>(undefined);
  function onMenuOpen(open: boolean) {
    if (!open || !isGithub || access !== undefined) return;
    setAccess(null);
    machineAccess(machine.id).then(setAccess, () => setAccess(null));
  }

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
        action === "revoke" && isGithub
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
  const busy = status.online && status.state === "busy";
  // Every job it's running, newest first (#179). An older API sends only the newest.
  const jobs = busy ? (machine.jobs ?? (machine.job ? [machine.job] : [])) : [];
  const job = jobs[0] ?? null;
  const { slots, running } = capacity(status);
  const tone: keyof typeof BANDS = missing
    ? "missing"
    : paused
      ? "paused"
      : !status.online
        ? "offline"
        : busy
          ? "running"
          : "idle";
  const label = {
    missing: "Not on GitHub",
    paused: "Paused",
    offline: "Offline",
    // A machine with several runners counts them; a 1-runner machine reads as before.
    running: slots > 1 ? `${Math.min(running, slots)} of ${slots} running` : "Running",
    idle: "Waiting for jobs",
  }[tone];
  const connection = missing
    ? "missing"
    : !status.online
      ? "offline"
      : paused
        ? "paused"
        : "online";

  const device = machine.device ?? null;
  const model = device ? deviceName(device) : null;
  const Icon = device ? KIND_ICONS[device.kind] : CpuIcon;
  const chip = isGithub
    ? { icon: <GithubIcon className="size-3.5" />, label: "Runner added from GitHub" }
    : { icon: <Icon className="size-3.5" aria-hidden />, label: model ?? "Self-hosted machine" };

  const platform = [
    device?.osVersion ?? (machine.os ? OS_NAMES[machine.os] : null),
    machine.arch ? ARCH_NAMES[machine.arch] : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const hardware = [
    device?.cpuCores != null ? `${device.cpuCores} cores` : null,
    device?.memoryMb != null ? formatMemory(device.memoryMb) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // How many jobs it runs at once, set by `connect --concurrency`. A runner added from GitHub runs
  // one. The gateway forgets the count once a machine disconnects (#346), so offline reads as not
  // reported.
  const runners = isGithub ? 1 : status.online ? slots : null;

  const githubUrl =
    github?.org && github.runnerId
      ? `${runnerSettingsUrl(github.org)}/${github.runnerId}`
      : github?.org
        ? runnerSettingsUrl(github.org)
        : null;

  // Whose machine it is and whose jobs it takes (#243). Only the owner of a connect machine
  // changes it; a runner added from GitHub belongs to its org and takes any job.
  const sharing = machine.sharing ?? "anyone";
  const mine = machine.mine ?? false;
  const canShare = mine && !isGithub;
  const SharingIcon = SHARING_ICONS[sharing];
  const ownerName = mine && !isGithub ? "You" : (machine.owner ?? null);

  // The band's right side: what it's doing, or why it isn't.
  const detail = missing
    ? "Removed or re-registered on GitHub"
    : paused
      ? `${paused.by ? `Paused by ${paused.by}` : "Paused from its CLI"} ${timeAgo(paused.at)}`
      : busy
        ? null
        : status.online
          ? // A connect machine's session: how long its terminal has been connected.
            !isGithub && status.connectedAt
            ? `Connected ${timeAgo(status.connectedAt)}`
            : null
          : isGithub
            ? github?.unreachable
              ? "Couldn't reach GitHub"
              : github?.org
                ? `In ${github.org}`
                : "Not reported by GitHub"
            : machine.lastSeenAt
              ? `Session ended ${timeAgo(machine.lastSeenAt)}`
              : "Never connected";

  // A runner added from GitHub lives in its org, not with a person. The GitHub mark keeps the
  // org's name from reading as the app's (an org can be named "relayrunner").
  const owner = isGithub ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <GithubIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{machine.owner ?? "GitHub"}</span>
    </span>
  ) : ownerName ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <UserAvatar
        user={{
          name: ownerName === "You" ? (machine.owner ?? "You") : ownerName,
          image: machine.ownerImage,
        }}
        className="size-4 border-0 text-[9px]"
      />
      <span className="truncate">{ownerName}</span>
    </span>
  ) : (
    <NotReported />
  );
  const runs = canShare ? (
    <button
      type="button"
      onClick={() => setSharingOpen(true)}
      aria-label={`Who can run jobs here: ${sharingLabel(sharing, true)}. Change`}
      className="-mx-1 -my-0.5 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <SharingIcon aria-hidden className="size-3.5 shrink-0 text-idle" />
      <span className="truncate">{sharingLabel(sharing, true)}</span>
    </button>
  ) : (
    <span className="flex min-w-0 items-center gap-1">
      <SharingIcon aria-hidden className="size-3.5 shrink-0 text-idle" />
      <span className="truncate">{sharingLabel(sharing, mine)}</span>
    </span>
  );

  return (
    <Card
      label={machine.name}
      dim={tone === "offline"}
      className={cn(missing && "border-destructive/50")}
    >
      <div className="grid min-w-0 gap-4 px-4 pt-3.5 pb-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconChip
            icon={chip.icon}
            label={chip.label}
            status={CONNECTION[connection]}
            session={!isGithub}
          />
          <h3
            title={machine.name}
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-sm font-medium",
              tone === "offline" && "text-ink-2",
            )}
          >
            {machine.name}
          </h3>
          <DropdownMenu onOpenChange={onMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="-my-1 -mr-2 shrink-0 text-muted-foreground opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0"
                aria-label={`More actions for ${machine.name}`}
                disabled={pending !== null}
              >
                <EllipsisIcon aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {(machine.owner || access) && (
                <>
                  <DropdownMenuLabel className="grid font-normal text-muted-foreground">
                    {machine.owner && (
                      <span className="truncate">
                        {isGithub ? `In ${machine.owner}` : `Connected by ${machine.owner}`}
                      </span>
                    )}
                    {access && <span className="truncate text-xs">{access}</span>}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              {/* Only a machine's owner pauses it (#318); the API says who can. */}
              {machine.canRevoke === false ? null : paused ? (
                <DropdownMenuItem onSelect={() => void act("resume")}>
                  <PlayIcon aria-hidden />
                  Unpause
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
              {canShare && (
                <DropdownMenuItem onSelect={() => setSharingOpen(true)}>
                  <SharingIcon aria-hidden />
                  <span className="grid">
                    <span>Sharing…</span>
                    <span className="text-xs text-muted-foreground">
                      {sharingLabel(sharing, true)}
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
              {machine.labels && machine.labels.length > 0 && (
                <DropdownMenuItem onSelect={() => void copyLabels()}>
                  <CopyIcon aria-hidden />
                  <span className="grid min-w-0">
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
              {/* Only a machine's owner revokes it (#318); the API says which. */}
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
        </div>

        {specs ? (
          <>
            {/* Every card fills the same four specs, so each sits in the same place down the grid. */}
            <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <Field label="Platform">
                {platform ? <Value>{platform}</Value> : <NotReported />}
              </Field>
              <Field label="Hardware">
                {hardware ? <Value>{hardware}</Value> : <NotReported />}
              </Field>
              <Field label="Runners">
                {runners != null ? <Value>{runners}</Value> : <NotReported />}
              </Field>
              <Field label="Typical job">
                {jobTime && jobTime.samples > 0 ? (
                  <Link
                    to="/job-times"
                    title={`Typical job · ${plural(jobTime.samples, "run")} in 14 days`}
                    className="truncate hover:text-foreground"
                  >
                    {medianText(jobTime)}
                  </Link>
                ) : (
                  <NotReported />
                )}
              </Field>
            </dl>
            {/* Whose it is and whose jobs it takes (#243), apart from the hardware. */}
            <dl className="grid min-w-0 grid-cols-2 gap-x-4 border-t pt-3.5 text-xs">
              <Field label={isGithub ? "Registered in" : "Owner"}>{owner}</Field>
              <Field label="Runs">{runs}</Field>
            </dl>
          </>
        ) : (
          // Simple by default: whose it is and whose jobs it takes, on one line.
          <div className="flex min-w-0 items-center justify-between gap-4 text-xs text-ink-2">
            {owner}
            {runs}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      {canShare && (
        <SharingDialog
          machineId={machine.id}
          machineName={machine.name}
          sharing={sharing}
          open={sharingOpen}
          onOpenChange={setSharingOpen}
        />
      )}

      {confirming ? (
        <Band tone="missing">
          <span className="min-w-0 truncate text-foreground">
            {isGithub ? "Remove from RelayRunner?" : "Revoke this machine?"}
          </span>
          <span className="flex shrink-0 gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
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
          </span>
        </Band>
      ) : (
        <Band tone={tone}>
          {tone === "paused" ? (
            <Button
              size="xs"
              variant="outline"
              className="-ml-1 shrink-0"
              disabled={pending !== null}
              onClick={() => void act("resume")}
            >
              {pending === "resume" ? "Unpausing…" : "Unpause"}
            </Button>
          ) : (
            <BandLabel tone={tone}>{label}</BandLabel>
          )}
          {job ? (
            <span className="flex min-w-0 items-center gap-2">
              <a
                href={job.url}
                target="_blank"
                rel="noreferrer"
                title={`${job.repository} · ${job.name}`}
                className="flex min-w-0 items-baseline gap-2 text-ink-2 hover:underline"
              >
                <span className="min-w-0 truncate">
                  {job.repository} · {job.name}
                </span>
                {job.startedAt && (
                  <span className="shrink-0 text-muted-foreground">{timeAgo(job.startedAt)}</span>
                )}
              </a>
              {jobs.length > 1 && <MoreJobs jobs={jobs.slice(1)} />}
            </span>
          ) : busy ? (
            <span className="min-w-0 truncate text-ink-2">Running a job</span>
          ) : (
            <span className="min-w-0 truncate text-muted-foreground" title={detail ?? undefined}>
              {detail}
            </span>
          )}
        </Band>
      )}
    </Card>
  );
}

// Runners already on GitHub that RelayRunner isn't using: a stub card with the same rows.
export function FoundCard({
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
    <article
      aria-label="Runners found on GitHub"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-dashed"
    >
      <div className="grid min-w-0 gap-2 px-4 pt-3 pb-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
            <GithubIcon className="size-3.5" />
          </span>
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
            {count} {count === 1 ? "runner" : "runners"} found
          </h3>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-my-1 -mr-2 shrink-0 text-muted-foreground"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          Already registered in <span className="font-mono">{orgs.join(", ")}</span> on GitHub
        </p>
      </div>
      <div className="mt-auto flex min-h-10 items-center border-t border-dashed px-4 py-2 text-xs">
        <button
          type="button"
          className="-mx-1 rounded-sm px-1 font-semibold text-go outline-none hover:text-go-hover focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={onReview}
        >
          Review and add
        </button>
      </div>
    </article>
  );
}

/** One card per cloud provider, with a row for each runner type its jobs used. */
export function CloudProviderCard({
  provider,
  environments,
}: {
  provider: Provider;
  environments: EnvironmentSummary[];
}) {
  const { name, icon, tile, tint, bar, url } = providerStyle(provider);
  const total = environments.reduce((sum, env) => sum + env.stat.runs, 0);
  // A share bar only says something when there's more than one runner type to compare.
  const showShare = environments.length > 1;
  return (
    <Card label={name}>
      <div className={cn("flex items-center gap-2.5 border-b border-line-soft px-4 py-3", tint)}>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${name}`}
            title={`Open ${name}`}
            className={cn(
              TILE,
              tile,
              "outline-none hover:opacity-85 focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          >
            {icon}
          </a>
        ) : (
          <span className={cn(TILE, tile)}>{icon}</span>
        )}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
          {provider === "machine" ? (
            name
          ) : (
            <Link
              to="/providers/$provider"
              params={{ provider }}
              className="rounded-sm outline-none hover:underline hover:underline-offset-2 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {name}
            </Link>
          )}
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">{plural(total, "job")}</span>
      </div>
      {/* One grid for every row, so share bars and numbers line up down the card. */}
      <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto] divide-y divide-line-soft py-1">
        {environments.map((env) => (
          <CloudRow
            key={env.key}
            environment={env}
            provider={provider}
            share={showShare && total > 0 ? env.stat.runs / total : null}
            bar={bar}
          />
        ))}
      </ul>
    </Card>
  );
}

function CloudRow({
  environment,
  provider,
  share,
  bar,
}: {
  environment: EnvironmentSummary;
  provider: Provider;
  share: number | null;
  bar: string;
}) {
  const { label, detail, stat } = environment;
  const { mono, detail: showDetail } = providerStyle(provider);
  const name = runnerName(provider, label);
  const spec = showDetail && detail ? detail : null;
  return (
    <li className="col-span-3 grid grid-cols-subgrid items-center gap-x-3 px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
      <div className="grid min-w-0 gap-1.5">
        <span title={label} className="truncate text-sm text-foreground">
          <span className={cn(mono && "font-mono")}>{name}</span>
          {spec && <span className="text-xs text-muted-foreground"> · {spec}</span>}
        </span>
        {share !== null && (
          <span aria-hidden className="h-[3px] overflow-hidden rounded-full bg-raised-2">
            <span
              className={cn("block h-full rounded-full", bar)}
              style={{ width: `${Math.max(share * 100, 2)}%` }}
            />
          </span>
        )}
      </div>
      <span className="text-right">{plural(stat.runs, "job")}</span>
      {stat.samples > 0 ? (
        <Link
          to="/job-times"
          title={`Typical job · ${plural(stat.samples, "run")}`}
          className="flex items-center justify-end gap-1 hover:text-foreground"
        >
          <TimerIcon aria-hidden className="size-3.5 text-idle" />
          {medianText(stat)}
        </Link>
      ) : (
        <span />
      )}
    </li>
  );
}
