import { Link, useRouter } from "@tanstack/react-router";
import {
  BanIcon,
  BoxIcon,
  CopyIcon,
  CpuIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LaptopIcon,
  MemoryStickIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  ServerIcon,
  TimerIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { GithubIcon, runnerSettingsUrl } from "@/components/add-runner";
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
import { medianText, plural, type Stat } from "@/lib/job-times";
import { pauseMachine, resumeMachine, revokeMachine, timeAgo, type Machine } from "@/lib/machines";
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

// The card's bottom band: one tone per state, told apart by lightness as well as hue.
const BANDS = {
  running: { band: "bg-go-soft", label: "text-go", dot: "bg-go ring-[3px] ring-go/25" },
  idle: { band: "bg-raised-2", label: "text-go", dot: "bg-go" },
  paused: { band: "bg-run/10", label: "text-run", dot: "bg-run" },
  offline: {
    band: "bg-well",
    label: "text-muted-foreground",
    dot: "border-2 border-idle bg-transparent",
  },
  missing: { band: "bg-destructive/10", label: "text-destructive", dot: "bg-destructive" },
} as const;

/** A square chip with an icon, named by a tooltip. */
function IconChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex size-7 shrink-0 cursor-default items-center justify-center rounded-[7px] border bg-raised-2 text-ink-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {icon}
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
        "flex min-w-0 flex-col overflow-hidden rounded-xl border",
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

export function MachineCard({ machine, jobTime }: { machine: Machine; jobTime?: Stat }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<"revoke" | "pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A self-hosted runner added from GitHub: no connection of its own, removed rather than revoked.
  const isGithub = machine.source === "github";
  const github = isGithub ? (machine.github ?? null) : null;

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
  const job = status.online && status.state === "busy" ? (machine.job ?? null) : null;
  const busy = status.online && status.state === "busy";
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
    running: "Running",
    idle: "Idle",
  }[tone];

  const device = machine.device ?? null;
  const model = device ? deviceName(device) : null;
  const Icon = device ? KIND_ICONS[device.kind] : CpuIcon;
  const chip = isGithub
    ? { icon: <GithubIcon className="size-4" />, label: "Runner added from GitHub" }
    : { icon: <Icon className="size-4" aria-hidden />, label: model ?? "Self-hosted machine" };

  const platform = [
    device?.osVersion ?? (machine.os ? OS_NAMES[machine.os] : null),
    machine.arch ? ARCH_NAMES[machine.arch] : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const githubUrl =
    github?.org && github.runnerId
      ? `${runnerSettingsUrl(github.org)}/${github.runnerId}`
      : github?.org
        ? runnerSettingsUrl(github.org)
        : null;

  // The band's right side: what it's doing, or why it isn't.
  const detail = missing
    ? "Removed or re-registered on GitHub"
    : paused
      ? `${paused.by ? `By ${paused.by}` : "From its CLI"} ${timeAgo(paused.at)}`
      : busy
        ? null
        : status.online
          ? "Waiting for jobs"
          : isGithub
            ? github?.unreachable
              ? "Couldn't reach GitHub"
              : "Offline on GitHub"
            : machine.lastSeenAt
              ? `Last seen ${timeAgo(machine.lastSeenAt)}`
              : "Never connected";

  return (
    <Card
      label={machine.name}
      dim={tone === "offline"}
      className={cn(missing && "border-destructive/50")}
    >
      <div className="grid min-w-0 gap-3 px-4 pt-3.5 pb-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconChip icon={chip.icon} label={chip.label} />
          <h3
            title={machine.name}
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-[15px] font-semibold",
              tone === "offline" && "text-ink-2",
            )}
          >
            {machine.name}
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="-mr-2 shrink-0 text-muted-foreground"
                aria-label={`More actions for ${machine.name}`}
                disabled={pending !== null}
              >
                <EllipsisIcon aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {(machine.owner || github?.access) && (
                <>
                  <DropdownMenuLabel className="grid font-normal text-muted-foreground">
                    {machine.owner && (
                      <span className="truncate">
                        {isGithub ? `In ${machine.owner}` : `Connected by ${machine.owner}`}
                      </span>
                    )}
                    {github?.access && <span className="truncate text-xs">{github.access}</span>}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
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
        </div>

        <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{platform || "Unknown platform"}</span>
          <span className="flex shrink-0 items-center gap-3 tabular-nums">
            {jobTime && jobTime.samples > 0 && (
              <Link
                to="/job-times"
                title={`Typical job · ${plural(jobTime.samples, "run")} in 14 days`}
                className="flex items-center gap-1 hover:text-foreground"
              >
                <TimerIcon aria-hidden className="size-3.5 text-idle" />
                {medianText(jobTime)}
              </Link>
            )}
            {device?.cpuCores != null && (
              <span className="flex items-center gap-1" title={`${device.cpuCores} CPU cores`}>
                <CpuIcon aria-hidden className="size-3.5 text-idle" />
                {device.cpuCores}
              </span>
            )}
            {device?.memoryMb != null && (
              <span className="flex items-center gap-1" title="Memory">
                <MemoryStickIcon aria-hidden className="size-3.5 text-idle" />
                {formatMemory(device.memoryMb)}
              </span>
            )}
          </span>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

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
          <BandLabel tone={tone}>{label}</BandLabel>
          {job ? (
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
          ) : busy ? (
            <span className="min-w-0 truncate text-ink-2">Running a job</span>
          ) : paused ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-muted-foreground" title={detail ?? undefined}>
                {detail}
              </span>
              <Button
                size="xs"
                variant="outline"
                className="shrink-0"
                disabled={pending !== null}
                onClick={() => void act("resume")}
              >
                {pending === "resume" ? "Resuming…" : "Resume"}
              </Button>
            </span>
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
      <div className="grid min-w-0 gap-3 px-4 pt-3.5 pb-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] border border-dashed text-muted-foreground">
            <GithubIcon className="size-4" />
          </span>
          <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {count} {count === 1 ? "runner" : "runners"} on GitHub
          </h3>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-mr-2 shrink-0 text-muted-foreground"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          In <span className="font-mono">{orgs.join(", ")}</span>, not used by RelayRunner yet
        </p>
      </div>
      <div className="mt-auto flex min-h-10 items-center border-t border-dashed px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          className="text-go hover:text-go-hover"
          onClick={onReview}
        >
          Review and add
        </Button>
      </div>
    </article>
  );
}
