import { legalToAgree, type LegalDocument } from "@relayrunner/activity";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { BrandedPage } from "@/components/agent-sign-in";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorText } from "@/lib/api";
import { authDisabled, getSession } from "@/lib/auth-client";
import { signOut } from "@/lib/session";
import { agreeToLegal, LEGAL_LINKS } from "@/lib/legal";

type AgreeSearch = { redirect?: string };

// Everyone agrees to the Terms of Service and Privacy Policy before using the dashboard: once after
// signing up, and again when either changes (@relayrunner/activity LEGAL_VERSIONS). Route guards
// send people here with agreedSession (lib/legal.ts), whichever way they signed in.
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
    <BrandedPage>
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
            {Object.values(LEGAL_LINKS).map(({ label, href }) => (
              <li key={href}>
                <a
                  className="underline underline-offset-2"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {label}
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
    </BrandedPage>
  );
}

function titleOf(documents: LegalDocument[]) {
  return documents.length === 1 ? LEGAL_LINKS[documents[0]!].label : "Terms and Privacy Policy";
}
