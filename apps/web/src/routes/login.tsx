import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Brand } from "@/components/brand";
import { LegalNotice } from "@/components/legal-notice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authDisabled, getSession, signIn } from "@/lib/auth-client";
import { usePageTitle } from "@/lib/page-title";
import {
  AUTO_RETRY_DELAY_MS,
  canAutoRetry,
  describeSignInError,
  markAutoRetry,
  signInErrorURL,
} from "@/lib/sign-in";

// `error`: why the last sign-in failed, when GitHub's callback sends the browser back here.
type LoginSearch = { redirect?: string; error?: string };

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async ({ search }) => {
    if (authDisabled || (await getSession())) {
      throw redirect({ to: search.redirect ?? "/runners" });
    }
  },
  component: LoginPage,
});

// Agent sign-in (apps/api/src/auth/agent-auth.ts) sends the browser here with the MCP client's signed
// authorization request in the query. Signing in carries it on (auth-client.ts).
function connectingAgent() {
  return new URLSearchParams(window.location.search).has("sig");
}

function LoginPage() {
  usePageTitle("Sign in");
  const { redirect: next, error: errorCode } = Route.useSearch();
  const [retrying, setRetrying] = useState(() => canAutoRetry(errorCode));
  const [error, setError] = useState<string | null>(() =>
    retrying ? null : describeSignInError(errorCode),
  );

  async function signInWithGitHub() {
    setError(null);
    const { error } = await signIn.social({
      provider: "github",
      callbackURL: next ?? "/runners",
      errorCallbackURL: signInErrorURL(),
    });
    if (error) {
      setRetrying(false);
      setError(error.message ?? "Sign-in failed");
    }
  }

  // GitHub was briefly rate-limiting sign-ins (lib/sign-in.ts): try once more on our own.
  useEffect(() => {
    if (!retrying) return;
    const timer = setTimeout(() => {
      markAutoRetry();
      void signInWithGitHub();
    }, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Brand />
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              {connectingAgent()
                ? "Sign in to connect an agent to RelayRunner."
                : "Route your GitHub Actions to the right runner."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button
              size="lg"
              className="w-full font-bold"
              onClick={signInWithGitHub}
              disabled={retrying}
            >
              Sign in with GitHub
            </Button>
            {retrying && (
              <p className="text-sm text-muted-foreground">
                GitHub is busy right now. Trying again…
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <LegalNotice action="signing in" />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
