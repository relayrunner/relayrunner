import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentSignInPage, SignedOut } from "@/components/agent-sign-in";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { grantAgentWorkspaces } from "@/lib/agents";
import { authClient, getSession, organization } from "@/lib/auth-client";

// Agent sign-in, step 1 (apps/api/src/agent-auth.ts): after sign-in, Better Auth sends the browser
// here with the MCP client's signed authorization request in the query. The person picks which
// workspaces the agent may read (all of them to start), then we hand back to Better Auth, which
// asks for consent next.
export const Route = createFileRoute("/agents/workspace")({
  loader: async () => {
    const session = await getSession();
    if (!session) return { signedIn: false as const };
    const { data } = await organization.list();
    return {
      signedIn: true as const,
      workspaces: (data ?? []).map(({ id, name }) => ({ id, name })),
    };
  },
  component: AgentWorkspacePage,
});

function AgentWorkspacePage() {
  const loaded = Route.useLoaderData();
  return (
    <AgentSignInPage>
      {loaded.signedIn ? <PickWorkspaces workspaces={loaded.workspaces} /> : <SignedOut />}
    </AgentSignInPage>
  );
}

function PickWorkspaces({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const [picked, setPicked] = useState(() => new Set(workspaces.map((workspace) => workspace.id)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function choose() {
    setError(null);
    setPending(true);
    try {
      await grantAgentWorkspaces([...picked]);
      // Better Auth finds the grant for this session, then redirects to consent.
      const { error } = await authClient.oauth2.continue({ postLogin: true });
      if (error) throw new Error(error.message ?? "Couldn't continue");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't continue");
      setPending(false);
    }
  }

  if (workspaces.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>No workspace yet</CardTitle>
          <CardDescription>
            An agent reads your workspaces. Create one in the dashboard, then connect the agent
            again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="lg" className="w-full font-bold">
            <Link to="/workspaces/new">Create a workspace</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Connect an agent</CardTitle>
        <CardDescription>
          Choose the workspaces this agent can see. It gets read-only access to those only. Ones you
          join later need a new connection.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void choose();
          }}
        >
          <fieldset className="grid gap-2" disabled={pending}>
            <legend className="mb-1.5 text-sm font-medium">Workspaces</legend>
            {workspaces.map((workspace) => (
              <label
                key={workspace.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm hover:bg-accent/40"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-go)]"
                  checked={picked.has(workspace.id)}
                  onChange={() => toggle(workspace.id)}
                />
                {workspace.name}
              </label>
            ))}
          </fieldset>
          <Button
            type="submit"
            size="lg"
            className="w-full font-bold"
            disabled={pending || picked.size === 0}
          >
            {pending ? "Continuing…" : "Continue"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
