import { DEFAULT_RUNNER_ORDER, type RunnerKey, type RunnerStep } from "@relayrunner/runner-order";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { CheckIcon, CirclePlayIcon, CloudIcon, CopyIcon, LaptopIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  AddRunner,
  CONNECT_COMMAND,
  GithubIcon,
  GithubRunnersDialog,
} from "@/components/add-runner";
import { PageHeader } from "@/components/page-header";
import { FoundCard, MachineCard } from "@/components/runner-card";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authDisabled } from "@/lib/auth-client";
import { getMachineJobTimes, type Stat } from "@/lib/job-times";
import { addableRunners, listGithubRunners, listMachines } from "@/lib/machines";
import { canManage } from "@/lib/roles";
import { getRunnerOrder } from "@/lib/runner-order";
import { cn } from "@/lib/utils";

// Found runners per workspace, kept for the tab's life so leaving and coming back doesn't wait on
// GitHub again. The page still re-checks in the background on each visit.
type Found = { count: number; orgs: string[] };
const foundCache = new Map<string, Found>();
const dismissedFound = new Set<string>();

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

  // Runners in connected orgs that aren't added yet, for the found card. Owners and admins only,
  // since only they can add them. It asks GitHub, so it's read once per visit, not on every
  // refresh, and the last answer is kept for the tab so coming back shows it at once.
  const workspaceId = current.workspace.id;
  const [githubOpen, setGithubOpen] = useState(false);
  const [found, setFound] = useState<Found | null>(() => foundCache.get(workspaceId) ?? null);
  const [dismissed, setDismissed] = useState(() => dismissedFound.has(workspaceId));
  async function findRunners() {
    if (!editable) return;
    try {
      const { orgs } = await listGithubRunners({ groups: false });
      const addable = addableRunners(orgs);
      const withRunners = orgs.filter(
        (org) => "runners" in org && org.runners.some((r) => !r.machineId && !r.blocked),
      );
      const next = { count: addable.length, orgs: withRunners.map((org) => org.org) };
      foundCache.set(workspaceId, next);
      setFound(next);
    } catch {
      // Keep showing the last answer; GitHub may just be slow or down.
    }
  }
  useEffect(() => {
    setFound(foundCache.get(workspaceId) ?? null);
    setDismissed(dismissedFound.has(workspaceId));
    void findRunners();
    // Once per visit and workspace.
  }, [workspaceId, editable]);
  // Each machine's typical job over the last 14 days, loaded after the cards so they never wait on it.
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
  function dismissFound() {
    dismissedFound.add(workspaceId);
    setDismissed(true);
  }

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
      <PageHeader title="Runners" action={<AddRunner onAddExisting={() => setGithubOpen(true)} />}>
        Machines your private repo jobs can run on. The Router decides when they get them.
      </PageHeader>
      <div className="max-w-5xl">
        <TooltipProvider>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
            {machines.map((machine) => (
              <li key={machine.id} className="grid min-w-0">
                <MachineCard machine={machine} jobTime={jobTimes[machine.id]} />
              </li>
            ))}
            {found && found.count > 0 && !dismissed && (
              <li className="grid min-w-0">
                <FoundCard
                  count={found.count}
                  orgs={found.orgs}
                  onReview={() => setGithubOpen(true)}
                  onDismiss={dismissFound}
                />
              </li>
            )}
          </ul>
        </TooltipProvider>
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
      ? {
          icon: <GithubIcon className="size-5" />,
          name: "GitHub-hosted",
          when: "when it's closed, asleep or busy",
        }
      : fallback === "blacksmith"
        ? {
            icon: <CloudIcon aria-hidden className="size-5" />,
            name: "Blacksmith",
            when: "when it's closed, asleep or busy",
          }
        : {
            icon: <CloudIcon aria-hidden className="size-5" />,
            name: "Nowhere",
            when: "jobs that need it stop early",
          };

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-10 py-4 sm:py-12">
      <div className="grid justify-items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          Run CI on your laptop while you work
        </h1>
        <p className="max-w-[56ch] text-pretty text-muted-foreground">
          RelayRunner routes each job to whichever runner is free: your laptop now, GitHub when it's
          off, or whatever you set in the{" "}
          <Link to="/router" className="text-go hover:text-go-hover">
            Router
          </Link>
          .
        </p>
      </div>

      <figure
        aria-label="Where a private repo job runs"
        className="m-0 flex flex-col items-center gap-4 sm:flex-row sm:justify-center sm:gap-0"
      >
        <span className="flex items-center gap-2 rounded-full border bg-card px-4 py-2.5 text-sm whitespace-nowrap text-ink-2">
          <CirclePlayIcon aria-hidden className="size-[18px]" />
          Private repo job
        </span>
        <svg
          aria-hidden
          viewBox="0 0 110 190"
          className="hidden h-[190px] w-[110px] shrink-0 sm:block"
        >
          <path d="M0 95 C55 95 55 38 110 38" fill="none" className="stroke-go" strokeWidth="2" />
          <path
            d="M0 95 C55 95 55 152 110 152"
            fill="none"
            className="stroke-idle"
            strokeWidth="2"
            strokeDasharray="4 5"
          />
        </svg>
        <div className="grid gap-4 sm:gap-16">
          <RouteEnd
            on
            icon={<LaptopIcon aria-hidden className="size-5" />}
            name="Your laptop"
            when={
              <>
                while <code className="font-mono text-ink-2">relayrunner connect</code> is running
              </>
            }
          />
          <RouteEnd icon={elsewhere.icon} name={elsewhere.name} when={elsewhere.when} />
        </div>
      </figure>

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
          <Button variant="ghost" size="sm" className="mt-1" onClick={onAddExisting}>
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

// One end of the route diagram: where the job lands, and when.
function RouteEnd({
  on = false,
  icon,
  name,
  when,
}: {
  on?: boolean;
  icon: ReactNode;
  name: string;
  when: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-[10px] border",
          on ? "border-go-edge bg-go-soft text-go" : "bg-card text-ink-2",
        )}
      >
        {icon}
      </span>
      <span className="grid">
        <span className="text-[15px] font-semibold">{name}</span>
        <span className="text-sm text-muted-foreground">{when}</span>
      </span>
    </div>
  );
}
