import { LEGAL_VERSIONS, legalToAgree } from "@relayrunner/activity";
import { redirect } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { getSession } from "@/lib/auth-client";

export const LEGAL_LINKS = {
  terms: { label: "Terms of Service", href: "https://relayrunner.app/terms" },
  privacy: { label: "Privacy Policy", href: "https://relayrunner.app/privacy" },
} as const;

/**
 * The session, for route guards: null when signed out. Someone signed in who hasn't agreed to the
 * current Terms of Service and Privacy Policy goes to /agree first, and comes back to `href` after.
 */
export async function agreedSession(href: string) {
  const session = await getSession();
  if (session && legalToAgree(session.user).length > 0) {
    throw redirect({ to: "/agree", search: { redirect: href } });
  }
  return session;
}

/** Records agreeing to the current versions (POST /api/me/legal), which refreshes the session. */
export function agreeToLegal() {
  return api("/me/legal", { method: "POST", body: JSON.stringify(LEGAL_VERSIONS) });
}
