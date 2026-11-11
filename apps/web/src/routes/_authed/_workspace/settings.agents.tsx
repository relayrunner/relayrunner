import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { disconnectAgent, listAgents, MCP_URL, type ConnectedAgent } from "@/lib/agents";

export const Route = createFileRoute("/_authed/_workspace/settings/agents")({
  loader: () => listAgents(),
  component: AgentSettingsPage,
});

function AgentSettingsPage() {
  const { agents } = Route.useLoaderData();
  return (
    <section>
      <PageHeader title="Agents">
        Connect an AI agent to RelayRunner's MCP server to ask about your runners, runs and usage.
        Agents can read one workspace and can't change anything.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">MCP server</CardTitle>
            <CardDescription>
              Add this URL as a remote MCP server in your agent. It opens this dashboard to sign in
              and pick a workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <p className="rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all">
              {MCP_URL}
            </p>
          </CardContent>
        </Card>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You haven't connected an agent to this workspace.
          </p>
        ) : (
          agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)
        )}
      </div>
    </section>
  );
}

function AgentCard({ agent }: { agent: ConnectedAgent }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setError(null);
    setPending(true);
    try {
      await disconnectAgent(agent.id);
      await router.invalidate();
    } catch {
      setError("Couldn't disconnect it. Try again.");
      setPending(false);
    }
  }

  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{agent.clientName || "Unnamed agent"}</CardTitle>
        <CardDescription>
          Connected {new Date(agent.connectedAt).toLocaleDateString()}
          {agent.clientUri && <> · {agent.clientUri}</>}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void disconnect()}>
            {pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </CardAction>
      </CardHeader>
      {error && <p className="px-4 text-sm text-destructive">{error}</p>}
    </Card>
  );
}
