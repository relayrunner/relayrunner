import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AgentSignInPage, SignedOut } from "@/components/agent-sign-in";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pendingAgentWorkspaces } from "@/lib/agents";
import { authClient, getSession } from "@/lib/auth-client";

// Agent sign-in, step 2 (apps/api/src/agent-auth.ts): Better Auth sends the browser here, with the
// signed authorization request in the query, once the person has picked the workspaces (step 1). Allowing returns the browser to the client with a code; denying returns an error.
export const Route = createFileRoute("/agents/consent")({
  loader: async () => {
    if (!(await getSession())) return { signedIn: false as const };
    const clientId = new URLSearchParams(window.location.search).get("client_id") ?? "";
    const [client, picked] = await Promise.all([
      authClient.oauth2.publicClient({ query: { client_id: clientId } }),
      pendingAgentWorkspaces(),
    ]);
    return {
      signedIn: true as const,
      clientName: client.data?.client_name || "An MCP client",
      clientUri: client.data?.client_uri ?? null,
      workspaceNames: picked.workspaces.map((workspace) => workspace.name),
    };
  },
  component: AgentConsentPage,
});

function AgentConsentPage() {
  const loaded = Route.useLoaderData();
  return (
    <AgentSignInPage>{loaded.signedIn ? <Consent {...loaded} /> : <SignedOut />}</AgentSignInPage>
  );
}

function Consent({
  clientName,
  clientUri,
  workspaceNames,
}: {
  clientName: string;
  clientUri: string | null;
  workspaceNames: string[];
}) {
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(accept: boolean) {
    setError(null);
    setPending(accept ? "allow" : "deny");
    // The auth client sends the browser back to the agent with the result.
    const { error } = await authClient.oauth2.consent({ accept });
    if (error) {
      setError(error.message ?? "Something went wrong. Start again from your agent.");
      setPending(null);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Allow {clientName}?</CardTitle>
        <CardDescription>
          {clientUri ? (
            <a className="underline underline-offset-2" href={clientUri} rel="noreferrer">
              {clientUri}
            </a>
          ) : (
            "This agent"
          )}{" "}
          wants to read{" "}
          <span className="font-medium text-foreground">
            {new Intl.ListFormat("en", { type: "conjunction" }).format(workspaceNames)}
          </span>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2 text-sm">
          <p>It will be able to see:</p>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>Runners, their status and the runner order</li>
            <li>Workflow runs, jobs and where each one was routed</li>
            <li>Activity, usage and Actions minutes</li>
          </ul>
          <p className="text-muted-foreground">
            It can't change anything. You can disconnect it from each workspace any time in
            Settings, under Agents.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="w-full font-bold"
            disabled={pending !== null}
            onClick={() => void answer(true)}
          >
            {pending === "allow" ? "Allowing…" : "Allow"}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            disabled={pending !== null}
            onClick={() => void answer(false)}
          >
            {pending === "deny" ? "Denying…" : "Deny"}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
