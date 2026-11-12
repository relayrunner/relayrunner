import { legalToAgree, type LegalDocument } from "@relayrunner/activity";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorText } from "@/lib/api";
import { authDisabled, getSession, signOut } from "@/lib/auth-client";
import { agreeToLegal, LEGAL_LINKS } from "@/lib/legal";

type AgreeSearch = { redirect?: string };

// Everyone agrees to the Terms of Service and Privacy Policy before using the dashboard: once after
// signing up, and again when either changes (@relayrunner/activity LEGAL_VERSIONS). Route guards
// send people here with requireAgreement (lib/legal.ts), whichever way they signed in.
export const Route = createFileRoute("/agree")({
  validateSearch: (search: Record<string, unknown>): AgreeSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ search, location }) => {
    const next = search.redirect ?? "/runners";
    if (authDisabled) throw redirect({ to: next });
    const session = await getSession();
    if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
    const documents = legalToAgree(session.user);
    if (documents.length === 0) throw redirect({ to: next });
    const updated = Boolean(session.user.termsVersion || session.user.privacyVersion);
    return { next, documents, updated };
  },
  component: AgreePage,
});

const ERRORS = {
  outdated: "The terms changed since you opened this page. Reload it to read the new version.",
};

function AgreePage() {
  const { next, documents, updated } = Route.useRouteContext();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function agree() {
    setError(null);
    setPending(true);
    try {
      await agreeToLegal();
      router.history.push(next);
    } catch (caught) {
      setError(errorText(caught, ERRORS));
      setPending(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Brand />
        <Card className="w-full">
          <CardHeader>
            <CardTitle>
              {updated ? `We updated our ${titleOf(documents)}` : "Before you start"}
            </CardTitle>
            <CardDescription>
              {updated
                ? "Read what changed, then agree to keep going."
                : "Read and agree to the Terms of Service and Privacy Policy."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1 text-sm">
              {(["terms", "privacy"] as const).map((document) => (
                <li key={document}>
                  <a
                    className="underline underline-offset-2"
                    href={LEGAL_LINKS[document].href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {LEGAL_LINKS[document].label}
                  </a>
                </li>
              ))}
            </ul>
            <Button
              size="lg"
              className="w-full font-bold"
              disabled={pending}
              onClick={() => void agree()}
            >
              I agree
            </Button>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <button
              type="button"
              className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => void handleSignOut()}
            >
              Sign out
            </button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function titleOf([first, ...rest]: LegalDocument[]) {
  return rest.length || !first ? "Terms and Privacy Policy" : LEGAL_LINKS[first].label;
}
