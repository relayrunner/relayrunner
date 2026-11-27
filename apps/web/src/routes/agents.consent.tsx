import { createFileRoute } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { BrandedPage, SignedOut } from "@/components/agent-sign-in";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { agentRedirect, type AgentRedirect } from "@/lib/agent-redirect";
import { pendingAgentWorkspaces } from "@/lib/agents";
import { authClient } from "@/lib/auth-client";
import { agreedSession } from "@/lib/legal";
import { usePageTitle } from "@/lib/page-title";

// Agent sign-in, step 2 (apps/api/src/auth/agent-auth.ts): Better Auth sends the browser here, with the
// signed authorization request in the query, once the person has picked the workspaces (step 1). Allowing returns the browser to the client with a code; denying returns an error.
// The client named itself when it registered, so the page also says where the code goes (the
// query's redirect_uri, which Better Auth checked against the client's registered ones and signed)
// and warns about a website it doesn't know (src/lib/agent-redirect.ts).
export const Route = createFileRoute("/agents/consent")({
  loader: async ({ location }) => {
    if (!(await agreedSession(location.href))) return { signedIn: false as const };
    const query = new URLSearchParams(window.location.search);
    const clientId = query.get("client_id") ?? "";
    const [client, picked] = await Promise.all([
      authClient.oauth2.publicClient({ query: { client_id: clientId } }),
      pendingAgentWorkspaces(),
    ]);
    return {
      signedIn: true as const,
      clientName: client.data?.client_name || "An MCP client",
      clientUri: client.data?.client_uri ?? null,
      redirect: agentRedirect(query.get("redirect_uri")),
      workspaceNames: picked.workspaces.map((workspace) => workspace.name),
    };
  },
  component: AgentConsentPage,
});

function AgentConsentPage() {
  usePageTitle("Connect an agent");
  const loaded = Route.useLoaderData();
  return <BrandedPage>{loaded.signedIn ? <Consent {...loaded} /> : <SignedOut />}</BrandedPage>;
}

function Consent({
  clientName,
  clientUri,
  redirect,
  workspaceNames,
}: {
  clientName: string;
  clientUri: string | null;
  redirect: AgentRedirect | null;
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
        {redirect && <ReturnsTo redirect={redirect} />}
        <div className="grid gap-2 text-sm">
          <p>It will be able to see:</p>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>Runners, their status and the runner order</li>
            <li>Workflow runs, jobs and where each one was routed</li>
            <li>Activity, usage and Actions minutes</li>
          </ul>
          <p className="text-muted-foreground">
            It can't change anything until you allow changes for it in Settings, under Agents. You
            can disconnect it from each workspace there any time.
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

// Where Allow sends the browser, and a warning when that's a website we don't know.
function ReturnsTo({ redirect }: { redirect: AgentRedirect }) {
  if (redirect.kind === "web" && !redirect.known) {
    return (
      <div
        role="alert"
        className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="grid gap-1">
          <p>
            Allowing sends you to{" "}
            <span className="font-medium text-foreground">{redirect.host}</span>, a website we don't
            recognize.
          </p>
          <p className="text-muted-foreground">
            Anyone can give their app any name. Allow it only if you started connecting this agent
            yourself and you trust {redirect.host}.
          </p>
        </div>
      </div>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Allowing sends you to{" "}
      <span className="font-medium text-foreground">
        {redirect.kind === "app" ? `the ${redirect.scheme} app` : redirect.host}
      </span>
      {redirect.kind === "app" || redirect.kind === "local" ? " on this computer" : ""}.
    </p>
  );
}
