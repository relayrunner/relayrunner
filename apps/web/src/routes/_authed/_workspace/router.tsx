import { DEFAULT_RUNNER_ORDER, type RunnerKey } from "@relayrunner/runner-order";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { RunnerOrderEditor } from "@/components/runner-order-editor";
import { Badge } from "@/components/ui/badge";
import { authDisabled } from "@/lib/auth-client";
import { listMachines, type Machine } from "@/lib/machines";
import { canManage } from "@/lib/roles";
import { getRunnerOrder } from "@/lib/runner-order";

export const Route = createFileRoute("/_authed/_workspace/router")({
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
  component: RouterPage,
});

// Where jobs go: the runner order. The runners themselves live on the Runners page.
function RouterPage() {
  const loaded = Route.useLoaderData();
  const { current } = Route.useRouteContext();
  // Owners and admins change the order (#134); members read it. The API refuses a member's save.
  const editable = canManage(current.role);

  return (
    <section>
      <PageHeader
        title="Router"
        action={loaded.isDefault ? <Badge variant="outline">Default</Badge> : undefined}
      >
        Where jobs go. Each job takes the first step that can run it.{" "}
        {editable
          ? "Most workspaces never change this."
          : "Owners and admins can change the order."}
      </PageHeader>
      <div className="grid max-w-3xl gap-3">
        <RunnerOrderEditor
          workspaceId={current.workspace.id}
          order={loaded.order}
          isDefault={loaded.isDefault}
          editable={editable}
          meta={(key) => meta(key, loaded.machines)}
          body={() => null}
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
  const online = active.filter((machine) => machine.status?.online && !machine.paused).length;
  const count = active.length;
  return `${count} ${count === 1 ? "runner" : "runners"}${count ? ` · ${online} online` : ""} · spread by least recently picked · never for public repos`;
}
