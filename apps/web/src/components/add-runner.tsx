import { useEffect, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LaptopIcon,
  PlusIcon,
  ServerIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError } from "@/lib/api";
import {
  addGithubRunners,
  listGithubRunners,
  type OrgRunner,
  type OrgRunners,
} from "@/lib/machines";
import { cn } from "@/lib/utils";

export const CONNECT_COMMAND = "npx relayrunner connect";

/**
 * "Add runner" menu on the Runners page: a self-hosted runner already registered on GitHub, a
 * machine connected with the CLI, and remote machines later. The page owns the GitHub dialog, so
 * its "found runners" banner can open it too.
 */
export function AddRunner({ onAddExisting }: { onAddExisting: () => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            <PlusIcon />
            Add runner
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={onAddExisting} className="items-start">
            <GithubIcon className="mt-0.5" />
            <span className="grid gap-0.5">
              <span>Existing GitHub runner</span>
              <span className="text-xs text-muted-foreground">
                Already registered in your org. Nothing to install.
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLocalOpen(true)} className="items-start">
            <LaptopIcon className="mt-0.5" />
            <span className="grid gap-0.5">
              <span>Connect a machine</span>
              <span className="text-xs text-muted-foreground">
                Run the CLI on a laptop or server.
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <ServerIcon />
            Remote machine
            <Badge variant="idle" className="ml-auto px-1.5 text-[10px] tracking-wider">
              SOON
            </Badge>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LocalMachineDialog open={localOpen} onOpenChange={setLocalOpen} />
    </>
  );
}

/** GitHub's mark, which lucide no longer ships. */
export function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
    >
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.08-.12-.3-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.75.11 3.05.74.8 1.19 1.82 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

type Loaded =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error" }
  | { kind: "ready"; orgs: OrgRunners[] };

/**
 * Picks self-hosted runners already registered in the workspace's connected orgs and adds them.
 * RelayRunner puts one label on each runner on GitHub; nothing changes on the machine.
 */
export function GithubRunnersDialog({
  open,
  onOpenChange,
  onAdded,
  hasAccounts,
}: {
  open: boolean;
  /** Whether the workspace has any GitHub account connected, org or personal. */
  hasAccounts: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void | Promise<void>;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded({ kind: "loading" });
    setPicked(new Set());
    setError(null);
    listGithubRunners()
      .then(({ orgs }) => !cancelled && setLoaded({ kind: "ready", orgs }))
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded({ kind: err instanceof ApiError && err.status === 403 ? "forbidden" : "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const key = (installationId: number, runnerId: number) => `${installationId}:${runnerId}`;
  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function add() {
    setAdding(true);
    setError(null);
    const byInstallation = new Map<number, number[]>();
    for (const id of picked) {
      const [installationId = 0, runnerId = 0] = id.split(":").map(Number);
      byInstallation.set(installationId, [...(byInstallation.get(installationId) ?? []), runnerId]);
    }
    try {
      for (const [installationId, runnerIds] of byInstallation)
        await addGithubRunners(installationId, runnerIds);
      await onAdded();
      onOpenChange(false);
    } catch {
      setError("Couldn't add the runners. Try again.");
    } finally {
      setAdding(false);
    }
  }

  const orgs = loaded.kind === "ready" ? loaded.orgs : [];
  const found = orgs.some((org) => "runners" in org && org.runners.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add runners from GitHub</DialogTitle>
          <DialogDescription>
            Self-hosted runners already registered in your connected orgs. RelayRunner adds one
            label to each runner on GitHub. Nothing changes on the machine.
          </DialogDescription>
        </DialogHeader>

        {loaded.kind === "loading" && (
          <p className="text-sm text-muted-foreground" role="status">
            Looking for runners…
          </p>
        )}
        {loaded.kind === "forbidden" && (
          <p className="text-sm text-muted-foreground">
            Only owners and admins can add GitHub runners, since they belong to the org. Ask one to
            add them, or connect your own machine.
          </p>
        )}
        {loaded.kind === "error" && (
          <p className="text-sm text-destructive">Couldn't load runners. Try again.</p>
        )}
        {loaded.kind === "ready" && orgs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {hasAccounts
              ? "Existing runners can only be added from GitHub orgs for now."
              : "Connect a GitHub account first."}
          </p>
        )}
        {loaded.kind === "ready" && orgs.length > 0 && !found && (
          <div className="grid gap-2 text-sm">
            <p className="font-medium">No self-hosted runners found</p>
            <p className="text-muted-foreground">
              Register one in your org's Actions settings, then come back.
            </p>
            <div className="flex flex-wrap gap-2">
              {orgs.map((org) => (
                <Button key={org.installationId} asChild size="sm" variant="outline">
                  <a href={runnerSettingsUrl(org.org)} target="_blank" rel="noreferrer">
                    {org.org} runner settings
                  </a>
                </Button>
              ))}
            </div>
          </div>
        )}
        {loaded.kind === "ready" && found && (
          <div className="grid max-h-[55vh] gap-4 overflow-y-auto">
            {orgs.map((org) => (
              <section key={org.installationId} className="grid gap-2">
                <h3 className="font-mono text-xs text-muted-foreground">{org.org}</h3>
                {"error" in org ? (
                  <p className="text-sm text-destructive">Couldn't read this org's runners.</p>
                ) : (
                  org.runners.map((runner) => (
                    <RunnerOption
                      key={runner.id}
                      runner={runner}
                      checked={picked.has(key(org.installationId, runner.id))}
                      onToggle={() => toggle(key(org.installationId, runner.id))}
                    />
                  ))
                )}
              </section>
            ))}
            <p className="text-xs text-muted-foreground">
              Don't see one? Runners registered to a single repo or an enterprise aren't supported
              yet.
            </p>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {loaded.kind === "ready" && found && (
            <Button disabled={picked.size === 0 || adding} onClick={() => void add()}>
              {adding
                ? "Adding…"
                : picked.size === 0
                  ? "Add runners"
                  : `Add ${picked.size} ${picked.size === 1 ? "runner" : "runners"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const runnerSettingsUrl = (org: string) =>
  `https://github.com/organizations/${encodeURIComponent(org)}/settings/actions/runners`;

function RunnerOption({
  runner,
  checked,
  onToggle,
}: {
  runner: OrgRunner;
  checked: boolean;
  onToggle: () => void;
}) {
  const status =
    runner.status === "online" ? (runner.busy ? "Online · Busy" : "Online · Idle") : "Offline";
  if (runner.machineId)
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm text-muted-foreground">
        <span>
          <span className="font-mono text-foreground">{runner.name}</span> already added
        </span>
        <CheckIcon aria-hidden className="size-4 text-go" />
      </div>
    );
  const blocked = runner.blocked === "workflows";
  return (
    <label
      className={cn(
        "flex gap-3 rounded-lg border px-3 py-3 text-sm",
        blocked ? "border-dashed text-muted-foreground" : "cursor-pointer hover:bg-accent/40",
        checked && "border-go-edge bg-go-soft",
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--color-go)]"
        checked={checked}
        disabled={blocked}
        onChange={onToggle}
      />
      <span className="grid min-w-0 flex-1 gap-1.5">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono">{runner.name}</span>
          <span className="text-xs text-muted-foreground">{status}</span>
        </span>
        {runner.labels.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {runner.labels.map((label) => (
              <Badge key={label} variant="outline" className="font-mono font-normal">
                {label}
              </Badge>
            ))}
          </span>
        )}
        {blocked ? (
          <span className="text-xs text-run">
            Its group only allows selected workflows, so RelayRunner can't route to it yet.
          </span>
        ) : (
          runner.access && <span className="text-xs text-muted-foreground">{runner.access}</span>
        )}
      </span>
    </label>
  );
}

function LocalMachineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a machine</DialogTitle>
          <DialogDescription>
            Run your workspace's private jobs on a laptop or server instead of spending GitHub
            minutes.
          </DialogDescription>
        </DialogHeader>
        <ol className="grid gap-4 text-sm">
          <Step n={1} title="Run the CLI on the machine">
            <p className="text-muted-foreground">Needs Node.js 22 or later.</p>
            <CopyCommand command={CONNECT_COMMAND} />
          </Step>
          <Step n={2} title="Approve it in your browser">
            <p className="text-muted-foreground">
              The CLI shows a code and opens this dashboard. Check the code matches, pick the
              workspace and a name for the machine, then approve.
            </p>
          </Step>
          <Step n={3} title="Keep it running">
            <p className="text-muted-foreground">
              The machine shows up on this page as online and picks up jobs one at a time. Press
              Ctrl-C to take it offline. Later runs reuse the saved sign-in.
            </p>
          </Step>
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-3 gap-y-1.5">
      <span className="flex size-6 items-center justify-center rounded-full border font-mono text-xs text-muted-foreground">
        {n}
      </span>
      <span className="self-center font-medium">{title}</span>
      <div className="col-start-2 grid gap-2">{children}</div>
    </li>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); the command is still selectable.
    }
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/50 py-1 pr-1 pl-3">
      <code className="overflow-x-auto font-mono text-sm whitespace-nowrap">
        <span className="text-muted-foreground select-none">$ </span>
        {command}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
