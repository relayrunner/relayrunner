import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
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
import { CopyCommand } from "@/components/add-runner";
import { SKILLS_INSTALL } from "@/lib/route-repo";
import { DOCS_URL } from "@/components/site-footer";
import { disconnectAgent, listAgents, setAgentChanges, type ConnectedAgent } from "@/lib/agents";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/time-zone";

export const Route = createFileRoute("/_authed/_workspace/settings/agents")({
  loader: () => listAgents(),
  component: AgentSettingsPage,
});

function AgentSettingsPage() {
  const { mcpUrl, agents } = Route.useLoaderData();
  return (
    <section>
      <PageHeader className="max-w-3xl" title="Agents">
        Connect an AI agent to RelayRunner's MCP server to ask about your runners, runs and usage.
        Agents read the workspaces you pick when you connect them. They change settings only where
        you allow it.{" "}
        <a
          href={`${DOCS_URL}/reference/mcp`}
          className="text-foreground underline underline-offset-2"
        >
          See what they can read
        </a>
        .
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        <ConnectGuide mcpUrl={mcpUrl} />
        <SkillsCard />
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

// How to add the server in the agents people use most. Every client signs in the same way: it opens
// this dashboard to sign in, pick workspaces and approve.
const CLIENTS: { name: string; steps: (url: string) => ReactNode }[] = [
  {
    name: "Claude Code",
    steps: (url) => (
      <>
        <Step>Add the server, then run /mcp in Claude Code to sign in.</Step>
        <CopyCommand command={`claude mcp add --transport http relayrunner ${url}`} />
      </>
    ),
  },
  {
    name: "Claude",
    steps: (url) => (
      <>
        <Step>
          In Claude, open Settings, then Connectors, and choose Add custom connector. Name it
          RelayRunner and paste this URL, then choose Connect.
        </Step>
        <CopyCommand command={url} prompt={false} />
      </>
    ),
  },
  {
    name: "Cursor",
    steps: (url) => (
      <>
        <Step>
          Add this to ~/.cursor/mcp.json, then choose Connect next to RelayRunner in Cursor's MCP
          settings.
        </Step>
        <CopyCommand
          command={JSON.stringify({ mcpServers: { relayrunner: { url } } })}
          prompt={false}
        />
      </>
    ),
  },
  {
    name: "VS Code",
    steps: (url) => (
      <>
        <Step>Add the server, then start it from the MCP Servers list to sign in.</Step>
        <CopyCommand
          command={`code --add-mcp '${JSON.stringify({ name: "relayrunner", type: "http", url })}'`}
        />
      </>
    ),
  },
  {
    name: "Other",
    steps: (url) => (
      <>
        <Step>
          Add this URL as a remote MCP server (streamable HTTP). The agent signs in with OAuth, so
          there's no key to paste.
        </Step>
        <CopyCommand command={url} prompt={false} />
      </>
    ),
  },
];

function Step({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function ConnectGuide({ mcpUrl }: { mcpUrl: string }) {
  const [picked, setPicked] = useState(CLIENTS[0]!);
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Connect an agent</CardTitle>
        <CardDescription>
          Pick your agent and follow the step. It opens this dashboard so you can sign in, choose
          workspaces and approve it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-4">
        <div role="tablist" aria-label="Agent" className="flex flex-wrap gap-1 border-b">
          {CLIENTS.map((client) => (
            <button
              key={client.name}
              type="button"
              role="tab"
              aria-selected={client === picked}
              onClick={() => setPicked(client)}
              className={cn(
                "-mb-px border-b-2 px-2.5 py-1.5 text-sm transition-colors",
                client === picked
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {client.name}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="grid gap-2">
          {picked.steps(mcpUrl)}
        </div>
      </CardContent>
    </Card>
  );
}

// The skills teach an agent the CLI, routing a repo's jobs and the MCP tools (skills/ at the repo root).
function SkillsCard() {
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Install the skills</CardTitle>
        <CardDescription>
          Teach your agent to set up machines, route a repo's jobs and read your CI. Works with
          Claude Code, Codex, Cursor and most other agents.{" "}
          <a
            href={`${DOCS_URL}/get-started/agents#install-the-skills`}
            className="text-foreground underline underline-offset-2"
          >
            What each skill does
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <CopyCommand command={SKILLS_INSTALL} />
      </CardContent>
    </Card>
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
          Connected {formatDate(agent.connectedAt)}
          {agent.clientUri && <> · {agent.clientUri}</>}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void disconnect()}>
            {pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        <AllowChanges agent={agent} />
      </CardContent>
      {error && <p className="px-4 text-sm text-destructive">{error}</p>}
    </Card>
  );
}

// Lets the agent make the changes its person can make here: the runner order, sizes, retries, AI
// and pausing. The API checks each change as it would for the dashboard.
function AllowChanges({ agent }: { agent: ConnectedAgent }) {
  const [enabled, setEnabled] = useState(agent.canWrite);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setEnabled(next);
    setPending(true);
    setError(null);
    try {
      await setAgentChanges(agent.id, next);
    } catch (caught) {
      setEnabled(!next);
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <label className="flex cursor-pointer gap-3 text-sm has-disabled:cursor-default">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--color-go)]"
        checked={enabled}
        disabled={pending}
        onChange={(e) => void toggle(e.target.checked)}
      />
      <span className="grid gap-0.5">
        <span className="font-medium">Allow changes</span>
        <span className="text-muted-foreground">
          Make the changes you can make here, such as the runner order, job sizes and retries, or
          pausing machines. Each change shows in Activity.
        </span>
        {error && <span className="text-destructive">{error}</span>}
      </span>
    </label>
  );
}
