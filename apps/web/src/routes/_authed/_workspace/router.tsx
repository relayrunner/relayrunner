import { DEFAULT_RUNNER_ORDER, type RunnerOrder } from "@relayrunner/runner-order";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { RunnerOrderEditor } from "@/components/runner-order-editor";
import { Badge } from "@/components/ui/badge";
import { getActionsUsage, type AccountUsage } from "@/lib/actions-usage";
import { sampleRouterAccounts } from "@/lib/router-sample";
import { authDisabled } from "@/lib/auth-client";
import { listMachines, type Machine } from "@/lib/machines";
import { canManage } from "@/lib/roles";
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

  return (
    <section>
      <PageHeader
        title="Router"
        action={loaded.isDefault ? <Badge variant="outline">Default</Badge> : undefined}
      >
        Where jobs go. Each job takes the first step that can run it.
        {!editable && " Owners and admins can change the order."}
      </PageHeader>
      <div className="max-w-5xl">
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
      </div>
    </section>
  );
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
