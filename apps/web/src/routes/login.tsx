import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authDisabled, getSession, signIn } from "@/lib/auth-client";

type LoginSearch = { redirect?: string };

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ search }) => {
    if (authDisabled || (await getSession())) {
      throw redirect({ to: search.redirect ?? "/runners" });
    }
  },
  component: LoginPage,
});

// Agent sign-in (apps/api/src/agent-auth.ts) sends the browser here with the MCP client's signed
// authorization request in the query. Signing in carries it on (auth-client.ts).
function connectingAgent() {
  return new URLSearchParams(window.location.search).has("sig");
}

function LoginPage() {
  const { redirect: next } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);

  async function signInWithGitHub() {
    setError(null);
    const { error } = await signIn.social({
      provider: "github",
      callbackURL: next ?? "/runners",
    });
    if (error) setError(error.message ?? "Sign-in failed");
  }

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Brand />
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              {next?.startsWith("/invite/")
                ? "Sign in to join a workspace. New to RelayRunner? Signing in with GitHub creates your account."
                : connectingAgent()
                  ? "Sign in to connect an agent to RelayRunner."
                  : "Route your GitHub Actions to the right runner."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button size="lg" className="w-full font-bold" onClick={signInWithGitHub}>
              Sign in with GitHub
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-center text-xs text-muted-foreground">
              By signing in, you agree to the{" "}
              <a className="underline underline-offset-2" href="https://relayrunner.app/terms">
                Terms of Service
              </a>{" "}
              and{" "}
              <a className="underline underline-offset-2" href="https://relayrunner.app/privacy">
                Privacy Policy
              </a>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
