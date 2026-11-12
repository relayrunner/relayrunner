import { LEGAL_LINKS } from "@/lib/legal";

/** "By signing in, you agree to the Terms of Service and Privacy Policy." under a sign-in button. */
export function LegalNotice({ action }: { action: string }) {
  const link = (document: keyof typeof LEGAL_LINKS) => (
    <a className="underline underline-offset-2" href={LEGAL_LINKS[document].href}>
      {LEGAL_LINKS[document].label}
    </a>
  );
  return (
    <p className="text-center text-xs text-muted-foreground">
      By {action}, you agree to the {link("terms")} and {link("privacy")}.
    </p>
  );
}
