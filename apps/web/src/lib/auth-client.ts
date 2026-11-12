import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { inferAdditionalFields, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Better Auth lives in the apps/api Worker, mounted at /api/auth on the same
// origin as the dashboard, so session cookies need no CORS setup.
export const authClient = createAuthClient({
  basePath: "/api/auth",
  // Workspaces are Better Auth organizations (see apps/api/src/auth.ts).
  plugins: [
    organizationClient(),
    // user.role (apps/api/src/auth.ts): "operator" sees the Admin section. termsVersion and
    // privacyVersion: what they last agreed to (lib/legal.ts).
    inferAdditionalFields({
      user: {
        role: { type: "string", required: false, input: false },
        termsVersion: { type: "string", required: false, input: false },
        privacyVersion: { type: "string", required: false, input: false },
      },
    }),
    // Agent sign-in (apps/api/src/agent-auth.ts): on the pages Better Auth sends an MCP client's
    // sign-in through (/login, /agents/*), it adds the page's signed authorization request to
    // each call, so signing in or approving carries on to the next step.
    oauthProviderClient(),
  ],
});

export const { useSession, signIn, organization, useListOrganizations } = authClient;

export type Session = typeof authClient.$Infer.Session;

/** Dev-only escape hatch so pages render before the API exists. */
export const authDisabled = import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === "true";

/** Resolves the current session; null when signed out, or when it can't be read. */
export async function getSession(): Promise<Session | null> {
  return (await readSession()) ?? null;
}

/**
 * The current session, null when signed out, or undefined when it couldn't be read (offline, or
 * the API erred), so a background check can tell "signed out" from "couldn't tell".
 */
export async function readSession(): Promise<Session | null | undefined> {
  let session: Session | null;
  try {
    const { data, error } = await authClient.getSession();
    if (error) return undefined;
    session = data ?? null;
  } catch {
    return undefined;
  }
  rememberSignedIn(Boolean(session));
  return session;
}

/**
 * The homepage (apps/site, on the parent domain) swaps its header's Sign in for Open dashboard when
 * this cookie is set. The session cookie itself is HttpOnly and scoped to the dashboard's host, so
 * the site can't see it. This one holds no secret: it's only a hint, and a stale one just sends
 * someone to the sign-in page. Every session read sets or clears it, so signing out clears it too.
 */
const SIGNED_IN_COOKIE = "rr_signed_in";

function rememberSignedIn(signedIn: boolean) {
  // Only the dashboard at app.<domain> shares it with <domain>; previews and localhost don't.
  const { hostname } = window.location;
  if (!hostname.startsWith("app.")) return;
  const domain = hostname.slice("app.".length);
  const value = signedIn ? "1" : "";
  const maxAge = signedIn ? 60 * 60 * 24 * 30 : 0;
  document.cookie = `${SIGNED_IN_COOKIE}=${value}; Domain=${domain}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;
}
