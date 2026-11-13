import { DEFAULT_RUNNER_ORDER, type RunnerOrder } from "@relayrunner/runner-order";
import { createFileRoute } from "@tanstack/react-router";
import { RotateCwIcon, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { RetrySettingsCard } from "@/components/retry-settings";
import { RunnerOrderEditor } from "@/components/runner-order-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getActionsUsage, type AccountUsage } from "@/lib/actions-usage";
import { sampleRouterAccounts } from "@/lib/router-sample";
import { authDisabled } from "@/lib/auth-client";
import { listMachines, type Machine } from "@/lib/machines";
import {
  clearUnhealthyRunner,
  getProviderHealth,
  setSkipUnhealthy,
  type ProviderHealth,
  type UnhealthyRunner,
} from "@/lib/provider-health";
import { canManage } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { getRunnerOrder } from "@/lib/runner-order";

export const Route = createFileRoute("/_authed/_workspace/router")({
  loader: async ({ context }) => {
    // The dev preview has no API behind it: show a sample workspace instead.
    if (authDisabled) return sampleRouter();
    // Runner status isn't awaited here: a runner added from GitHub reads its status from GitHub,
    // so the page loads first and the Self-hosted step's badge fills in after (RouterPage).
    const [order, accounts] = await Promise.all([
      getRunnerOrder(context.current.workspace.id),
      // The minutes only explain the GitHub step's limit, so the page still loads without them.
      getActionsUsage()
        .then((usage) => usage.accounts)
        .catch((): AccountUsage[] => []),
    ]);
    return { ...order, machines: null as Machine[] | null, accounts };
  },
  component: RouterPage,
});

// Where jobs go: the runner order. The runners themselves live on the Runners page.
function RouterPage() {
  const loaded = Route.useLoaderData();
  const { current } = Route.useRouteContext();
  // Owners and admins change the order (#134); members read it. The API refuses a member's save.
  const editable = canManage(current.role);
  // The machines' live status, for the Self-hosted step's badge. Null until it arrives.
  const [machines, setMachines] = useState<Machine[] | null>(loaded.machines);
  useEffect(() => {
    if (loaded.machines) return;
    let live = true;
    listMachines().then(
      ({ machines }) => live && setMachines(machines),
      // Without it the badge stays off; the order itself is still right.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [loaded.machines]);

  const health = useProviderHealth(current.workspace.id);

  return (
    <section>
      <PageHeader
        title="Router"
        action={loaded.isDefault ? <Badge variant="outline">Default</Badge> : undefined}
      >
        Where jobs go. Each job takes the first step that can run it.
        {!editable && " Owners and admins can change the order."}
      </PageHeader>
      <div className="grid max-w-5xl gap-4">
        <SectionBoundary>
          <UnhealthyRunners health={health} editable={editable} />
        </SectionBoundary>
        <SectionBoundary>
          <RunnerOrderEditor
            // The page can first show cached data, then fresh: remount when the saved order changes.
            key={JSON.stringify(loaded.order.steps)}
            workspaceId={current.workspace.id}
            order={loaded.order}
            isDefault={loaded.isDefault}
            editable={editable}
            machines={machines}
            accounts={loaded.accounts}
          />
        </SectionBoundary>
        <SectionBoundary>
          <SkipUnhealthyToggle health={health} editable={editable} />
        </SectionBoundary>
        <SectionBoundary>
          <RetrySettingsCard workspaceId={current.workspace.id} editable={editable} />
        </SectionBoundary>
      </div>
    </section>
  );
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

type HealthState = ReturnType<typeof useProviderHealth>;

// Whether the Router skips hosted runner types that stop picking up jobs, and the ones it skips now.
// Null until it loads, and when it can't be read: the page still works without it.
function useProviderHealth(workspaceId: string) {
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  useEffect(() => {
    let live = true;
    // The dev preview has no API behind it: `?sample=unhealthy` shows one skipped runner type.
    const read = authDisabled ? sampleHealth() : getProviderHealth(workspaceId);
    read.then(
      (loaded) => live && setHealth(loaded),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  async function tryAgain(runner: UnhealthyRunner) {
    if (!authDisabled) await clearUnhealthyRunner(workspaceId, runner);
    setHealth((h) => h && { ...h, unhealthy: h.unhealthy.filter((r) => r !== runner) });
  }

  async function setEnabled(enabled: boolean) {
    if (!authDisabled) await setSkipUnhealthy(workspaceId, enabled);
    setHealth((h) => h && { ...h, enabled });
  }

  return { health, tryAgain, setEnabled };
}

// Hosted runner types the Router is skipping because their last jobs weren't picked up, each with
// "Try again now". Nothing when every one is healthy or skipping is off.
function UnhealthyRunners({ health: state, editable }: { health: HealthState; editable: boolean }) {
  const [clearing, setClearing] = useState<UnhealthyRunner | null>(null);
  const { health, tryAgain } = state;
  if (!health?.enabled || health.unhealthy.length === 0) return null;

  async function clear(runner: UnhealthyRunner) {
    setClearing(runner);
    try {
      await tryAgain(runner);
    } finally {
      setClearing(null);
    }
  }

  return (
    <ul className="grid gap-2" aria-label="Skipped runners">
      {health.unhealthy.map((runner) => (
        <li
          key={`${runner.key}:${runner.label}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm"
        >
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1">
            <span className="font-medium">Skipping {runner.label}.</span>{" "}
            <span className="text-muted-foreground">
              The last {runner.misses} jobs on it weren't picked up.{" "}
              {runner.retryAt > Date.now()
                ? `The Router tries it again at ${clock(runner.retryAt)}.`
                : "The Router sends it the next job to see if it's back."}
            </span>
          </p>
          {editable && (
            <Button
              size="sm"
              variant="outline"
              disabled={clearing === runner}
              onClick={() => void clear(runner)}
            >
              <RotateCwIcon aria-hidden />
              Try again now
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

// The workspace's switch for skipping runner types that stop picking up jobs. Saves on change.
function SkipUnhealthyToggle({
  health: state,
  editable,
}: {
  health: HealthState;
  editable: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const { health, setEnabled } = state;
  if (!health) return null;

  async function toggle(enabled: boolean) {
    setSaving(true);
    setFailed(false);
    try {
      await setEnabled(enabled);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <label
      className={cn("flex gap-3 rounded-xl border px-4 py-3 text-sm", editable && "cursor-pointer")}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--color-go)]"
        checked={health.enabled}
        disabled={!editable || saving}
        onChange={(event) => void toggle(event.target.checked)}
      />
      <span className="grid gap-1">
        <span className="font-medium">Skip runners that stop picking up jobs</span>
        <span className="text-muted-foreground">
          When 3 jobs in a row on a hosted provider's runner wait 10 minutes and none starts, the
          Router sends jobs to the next step until that runner works again. Turn this off to keep
          sending jobs there.
        </span>
        {failed && <span className="text-destructive">Couldn't save. Try again.</span>}
      </span>
    </label>
  );
}

async function sampleHealth(): Promise<ProviderHealth> {
  if (new URLSearchParams(window.location.search).get("sample") !== "unhealthy")
    return { enabled: true, unhealthy: [] };
  return {
    enabled: true,
    unhealthy: [
      { key: "depot", label: "depot-ubuntu-24.04", misses: 3, retryAt: Date.now() + 8 * 60_000 },
    ],
  };
}

/**
 * Dev-preview data. `?sample=enterprise` shows an org inside a GitHub enterprise, whose minutes
 * can't be checked, `?sample=personal` a personal account whose owner hasn't signed in,
 * and `?sample=default` the order a new workspace starts with.
 */
function sampleRouter(): {
  order: RunnerOrder;
  isDefault: boolean;
  machines: Machine[];
  accounts: AccountUsage[];
} {
  const kind = new URLSearchParams(window.location.search).get("sample");
  const machine: Machine = {
    id: "m1",
    name: "mac-mini-2",
    os: "macos",
    arch: "arm64",
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
    status: { online: true, state: "idle", connectedAt: Date.now() },
  };
  if (kind === "default")
    return { order: DEFAULT_RUNNER_ORDER, isDefault: true, machines: [machine], accounts: [] };
  if (kind === "enterprise" || kind === "personal")
    return {
      order: { steps: [{ key: "machine" }, { key: "github" }] },
      isDefault: false,
      machines: [machine],
      accounts: sampleRouterAccounts(kind),
    };
  return {
    order: {
      steps: [{ key: "github", limit: { percent: 80 } }, { key: "machine" }, { key: "github" }],
    },
    isDefault: false,
    machines: [machine],
    accounts: sampleRouterAccounts("team"),
  };
}
