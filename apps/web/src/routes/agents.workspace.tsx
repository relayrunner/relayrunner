import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentSignInPage, SignedOut } from "@/components/agent-sign-in";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { authClient, getSession, organization } from "@/lib/auth-client";

// Agent sign-in, step 1 (apps/api/src/agent-auth.ts): after sign-in, Better Auth sends the browser
// here with the MCP client's signed authorization request in the query. The person picks which
// workspace the agent may read, then we hand back to Better Auth, which asks for consent next.
export const Route = createFileRoute("/agents/workspace")({
  loader: async () => {
    const session = await getSession();
    if (!session) return { signedIn: false as const };
    const { data } = await organization.list();
    return {
      signedIn: true as const,
      workspaces: (data ?? []).map(({ id, name }) => ({ id, name })),
      active: session.session.activeOrganizationId ?? null,
    };
  },
  component: AgentWorkspacePage,
});

function AgentWorkspacePage() {
  const loaded = Route.useLoaderData();
  return (
    <AgentSignInPage>
      {loaded.signedIn ? (
        <PickWorkspace workspaces={loaded.workspaces} active={loaded.active} />
      ) : (
        <SignedOut />
      )}
    </AgentSignInPage>
  );
}

function PickWorkspace({
  workspaces,
  active,
}: {
  workspaces: { id: string; name: string }[];
  active: string | null;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    workspaces.find((workspace) => workspace.id === active)?.id ?? workspaces[0]?.id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose() {
    setError(null);
    setPending(true);
    try {
      // A plain call, not the auth client: the client would attach the authorization request.
      await api("/auth/organization/set-active", {
        method: "POST",
        body: JSON.stringify({ organizationId: workspaceId }),
      });
      // Better Auth checks the session's workspace, then redirects to consent.
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
            An agent reads one workspace. Create one in the dashboard, then connect the agent again.
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
          Choose the workspace this agent can see. It gets read-only access to that workspace only.
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
          <label className="grid gap-1.5 text-sm font-medium">
            Workspace
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              value={workspaceId}
              disabled={pending}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="lg" className="w-full font-bold" disabled={pending}>
            {pending ? "Continuing…" : "Continue"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
