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
    // user.role (apps/api/src/auth.ts): "operator" sees the Admin section.
    inferAdditionalFields({ user: { role: { type: "string", required: false, input: false } } }),
    // Agent sign-in (apps/api/src/agent-auth.ts): on the pages Better Auth sends an MCP client's
    // sign-in through (/login, /agents/*), it adds the page's signed authorization request to
    // each call, so signing in or approving carries on to the next step.
    oauthProviderClient(),
  ],
});

export const { useSession, signIn, signOut, organization, useListOrganizations } = authClient;

export type Session = typeof authClient.$Infer.Session;

/** Dev-only escape hatch so pages render before the API exists. */
export const authDisabled = import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === "true";

/** Resolves the current session for route guards; null when signed out. */
export async function getSession(): Promise<Session | null> {
  try {
    const { data } = await authClient.getSession();
    return data ?? null;
  } catch {
    return null;
  }
}
