import { useEffect, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LaptopIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import { GithubIcon } from "@/components/provider-logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { AppError } from "@relayrunner/errors";
import {
  addGithubRunners,
  listGithubRunners,
  type GitHubRunner,
  type GitHubRunners,
} from "@/lib/machines";
import { MacAppButton, MacAppLink, ON_MAC } from "@/components/mac-app";
import { DOCS_URL } from "@/components/site-footer";
import { cn } from "@/lib/utils";

export const CONNECT_COMMAND = "npx relayrunner connect";

/**
 * "Add runner" menu on the Runners page: a self-hosted runner already registered on GitHub, a
 * machine connected with the CLI, and remote machines later. The page owns the GitHub dialog, so
 * its "found runners" banner can open it too.
 */
export function AddRunner({
  onAddExisting,
  onAddMine,
}: {
  onAddExisting: () => void;
  /** Opens the dialog of the user's own machines not in this workspace; left out when none. */
  onAddMine?: () => void;
}) {
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
          {onAddMine && (
            <DropdownMenuItem onSelect={onAddMine} className="items-start">
              <LaptopIcon className="mt-0.5" />
              <span className="grid gap-0.5">
                <span>Your other machines</span>
                <span className="text-xs text-muted-foreground">
                  Already connected, not in this workspace yet.
                </span>
              </span>
            </DropdownMenuItem>
          )}
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
                The Mac app or the CLI, on a laptop or server.
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
type Loaded =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error" }
  | { kind: "ready"; orgs: GitHubRunners[] };

/**
 * Picks self-hosted runners already registered in the workspace's connected org, or on its private
 * repos, and adds them. RelayRunner puts one label on each runner on GitHub; nothing changes on the
 * machine.
 */
export function GithubRunnersDialog({
  open,
  onOpenChange,
  onAdded,
  hasAccounts,
  initial,
  onLoaded,
}: {
  open: boolean;
  /** Runners the page already found, shown at once while the dialog reads their group access. */
  initial?: GitHubRunners[] | null;
  /** Called with each list the dialog reads, so the page's found runners stay current. */
  onLoaded?: (orgs: GitHubRunners[]) => void;
  /** Whether the workspace has any GitHub account connected, org or personal. */
  hasAccounts: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void | Promise<void>;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Looking in one repo by name, for an account with more private repos than the list searches.
  const [repoName, setRepoName] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);

  const [rescanning, setRescanning] = useState(false);

  // Reads the runners with their group access. A failed read keeps what's already shown.
  async function load(fresh = false, isCancelled = () => false) {
    try {
      const { orgs } = await listGithubRunners({ fresh });
      if (isCancelled()) return;
      setLoaded({ kind: "ready", orgs });
      onLoaded?.(orgs);
    } catch (err) {
      if (isCancelled()) return;
      setLoaded((current) =>
        current.kind === "ready"
          ? current
          : { kind: err instanceof AppError && err.status === 403 ? "forbidden" : "error" },
      );
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(initial?.length ? { kind: "ready", orgs: initial } : { kind: "loading" });
    setPicked(new Set());
    setError(null);
    setRepoName("");
    setLookupNote(null);
    void load(false, () => cancelled);
    return () => {
      cancelled = true;
    };
    // `initial` only seeds the dialog when it opens.
  }, [open]);

  async function rescan() {
    setRescanning(true);
    setLookupNote(null);
    await load(true);
    setRescanning(false);
  }

  const orgs = loaded.kind === "ready" ? loaded.orgs : [];
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
    // One call per org, or per repo for repo runners.
    const byPlace = new Map<
      string,
      { installationId: number; repositoryId?: number; runnerIds: number[] }
    >();
    for (const org of orgs) {
      if (!("runners" in org)) continue;
      for (const runner of org.runners) {
        if (!picked.has(key(org.installationId, runner.id))) continue;
        const place = `${org.installationId}:${runner.repo?.id ?? 0}`;
        const group = byPlace.get(place) ?? {
          installationId: org.installationId,
          repositoryId: runner.repo?.id,
          runnerIds: [],
        };
        group.runnerIds.push(runner.id);
        byPlace.set(place, group);
      }
    }
    try {
      await Promise.all(
        [...byPlace.values()].map(({ installationId, runnerIds, repositoryId }) =>
          addGithubRunners(installationId, runnerIds, repositoryId),
        ),
      );
      await onAdded();
      onOpenChange(false);
    } catch {
      setError("Couldn't add the runners. Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function lookInRepo(event: React.FormEvent) {
    event.preventDefault();
    const name = repoName.trim();
    if (!name) return;
    setLooking(true);
    setLookupNote(null);
    try {
      const { orgs: results } = await listGithubRunners({ repo: name });
      const hits = results.flatMap((org) => ("runners" in org ? org.runners : []));
      // Add what it found to the list, once each.
      setLoaded((current) =>
        current.kind !== "ready"
          ? current
          : {
              kind: "ready",
              orgs: current.orgs.map((org) => {
                const result = results.find((r) => r.installationId === org.installationId);
                if (!("runners" in org) || !result || !("runners" in result)) return org;
                const fresh = result.runners.filter((r) => !org.runners.some((o) => o.id === r.id));
                return { ...org, runners: [...org.runners, ...fresh] };
              }),
            },
      );
      setLookupNote(
        results.some((org) => "repoNotFound" in org && org.repoNotFound)
          ? `No private repo named ${name}.`
          : hits.length === 0
            ? `No self-hosted runners on ${name}.`
            : null,
      );
    } catch {
      setLookupNote("Couldn't look in that repo. Try again.");
    } finally {
      setLooking(false);
    }
  }

  const found = orgs.some((org) => "runners" in org && org.runners.length > 0);
  const moreRepos = orgs.some((org) => "runners" in org && org.moreRepos);
  const lookup = (
    <form className="grid gap-2" onSubmit={(event) => void lookInRepo(event)}>
      <label htmlFor="runner-repo" className="text-xs text-muted-foreground">
        {moreRepos
          ? "You have more than 100 private repos, so only the first 100 were checked. Look in another one by name:"
          : "Don't see one? Look in a repo by name:"}
      </label>
      <div className="flex gap-2">
        <Input
          id="runner-repo"
          className="font-mono"
          placeholder="repo-name"
          value={repoName}
          onChange={(event) => setRepoName(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={looking || !repoName.trim()}>
          {looking ? "Looking…" : "Look"}
        </Button>
      </div>
      {lookupNote && <p className="text-xs text-muted-foreground">{lookupNote}</p>}
    </form>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add runners from GitHub</DialogTitle>
          <DialogDescription>
            Self-hosted runners already registered in your org or on your private repos. RelayRunner
            adds one label to each runner on GitHub. Nothing changes on the machine.
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
              ? "The GitHub App is suspended on your account."
              : "Connect a GitHub account first."}
          </p>
        )}
        {loaded.kind === "ready" && orgs.length > 0 && !found && (
          <div className="grid gap-2 text-sm">
            <p className="font-medium">No self-hosted runners found</p>
            <p className="text-muted-foreground">
              Register one in your org's or a private repo's Actions settings, then come back.
            </p>
            <div className="flex flex-wrap gap-2">
              {orgs
                .filter((org) => !org.personal)
                .map((org) => (
                  <Button key={org.installationId} asChild size="sm" variant="outline">
                    <a href={runnerSettingsUrl(org.org)} target="_blank" rel="noreferrer">
                      {org.org} runner settings
                    </a>
                  </Button>
                ))}
            </div>
            {lookup}
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
            {lookup}
            <p className="text-xs text-muted-foreground">
              Runners registered on a public repo or an enterprise aren't supported.
            </p>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          {loaded.kind === "ready" && orgs.length > 0 && (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              disabled={rescanning}
              onClick={() => void rescan()}
            >
              <RefreshCwIcon aria-hidden className={cn(rescanning && "animate-spin")} />
              {rescanning ? "Rescanning…" : "Rescan"}
            </Button>
          )}
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

/** A repo's runner settings on GitHub, for a runner registered on `repo` (owner/name). */
export const repoRunnerSettingsUrl = (repo: string) =>
  `https://github.com/${repo}/settings/actions/runners`;

function RunnerOption({
  runner,
  checked,
  onToggle,
}: {
  runner: GitHubRunner;
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
          <Step
            n={1}
            title={ON_MAC ? "Get the Mac app, or run the CLI" : "Run the CLI on the machine"}
          >
            {ON_MAC && (
              <div className="flex flex-wrap items-center gap-2">
                <MacAppButton />
                <span className="text-muted-foreground">or, in a terminal:</span>
              </div>
            )}
            {!ON_MAC && (
              <p className="text-muted-foreground">
                Needs Node.js 22 or later. On a Mac? <MacAppLink />
              </p>
            )}
            <CopyCommand command={CONNECT_COMMAND} />
            <p className="text-muted-foreground">
              On a Mac with Apple silicon, each job runs in its own Linux VM, away from your files.
              Elsewhere, jobs run on the machine itself.{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={`${DOCS_URL}/runners/self-hosted#isolated-jobs-on-a-mac`}
                target="_blank"
                rel="noreferrer"
              >
                How isolated jobs work
              </a>
            </p>
          </Step>
          <Step n={2} title="Approve it in your browser">
            <p className="text-muted-foreground">
              The app or CLI shows a code and opens this dashboard. Check the code matches, pick the
              workspace and a name for the machine, then approve.
            </p>
          </Step>
          <Step n={3} title="Keep it running">
            <p className="text-muted-foreground">
              The machine shows up on this page as online and picks up jobs. Turn the app off, or
              press Ctrl-C in the terminal, to take it offline. Later runs reuse the saved sign-in.
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

/** A value to paste somewhere, with a copy button. `prompt` marks it as a shell command. */
export function CopyCommand({ command, prompt = true }: { command: string; prompt?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/50 py-1 pr-1 pl-3">
      <code className="overflow-x-auto font-mono text-sm whitespace-nowrap">
        {prompt && <span className="text-muted-foreground select-none">$ </span>}
        {command}
      </code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}

/** An icon button that copies `text` and shows a check for a moment. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); the text is still selectable.
    }
  }
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={copied ? "Copied" : label}
      className={className}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
