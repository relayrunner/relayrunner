import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { bearer, deviceAuthorization, jwt, oAuthProxy, organization } from "better-auth/plugins";
import { agentOAuth } from "./agent-auth.ts";
import { eq } from "drizzle-orm";
import { createDb, schema } from "./db/index.ts";
import { requestOrigin } from "./device-origin.ts";
import { sendEmail } from "./email.ts";
import { installSignIn } from "./install-sign-in.ts";
import { syncMembershipsFromGitHub } from "./memberships.ts";
import type { Env } from "./env.ts";

// Preview dashboards (Workers Builds `wrangler preview`) reach this Worker through their own API
// service binding, so requests arrive with the preview host. PREVIEW_ORIGINS lists their origin
// patterns, comma-separated, e.g. https://*-relayrunner-app.relayrun.workers.dev.
export function previewOrigins(env: Pick<Env, "PREVIEW_ORIGINS">) {
  return (env.PREVIEW_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// SESSION_COOKIE_DOMAIN (e.g. relayrun.workers.dev) when the request host is under it, so one
// sign-in covers production workers.dev and every preview URL there. Other hosts, like the custom
// domain or localhost, keep host-only cookies. workers.dev is a public suffix, so browsers accept
// relayrun.workers.dev as a cookie domain but never send it to another account's Workers.
export function sharedCookieDomain(env: Pick<Env, "SESSION_COOKIE_DOMAIN">, host?: string) {
  const domain = env.SESSION_COOKIE_DOMAIN?.trim();
  return domain && host?.endsWith(`.${domain}`) ? domain : undefined;
}

// The client_id `relayrunner connect` sends with its device code requests.
export const MACHINE_CLIENT_ID = "relayrunner-cli";

// Organization endpoints that don't fit workspaces whose members come from GitHub (#317): email
// invites, removing or leaving (GitHub would add the person back on their next sync), and
// renaming or deleting a workspace (it's the installation; uninstall the App instead).
export const DISABLED_WORKSPACE_PATHS = [
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/get-invitation",
  "/organization/list-invitations",
  "/organization/list-user-invitations",
  "/organization/remove-member",
  "/organization/leave",
  "/organization/update",
  "/organization/delete",
  "/organization/get-full-organization",
] as const;

// Workers only expose bindings per request, so build the auth instance per request too. It is
// cheap: no I/O happens until a handler runs. `waitUntil` (the request's ExecutionContext) lets
// mail go out after the response; without it (tests, scripts) the hook waits for the send.
// `host` is the request's hostname, which decides whether the session cookie is shared.
export function createAuth(
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
  host?: string,
) {
  const background = (promise: Promise<unknown>) => (waitUntil ? waitUntil(promise) : promise);
  const cookieDomain = sharedCookieDomain(env, host);
  const auth = betterAuth({
    // Always the production dashboard origin, so GitHub only ever sees one OAuth callback URL.
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    // The jwt plugin's /token turns a session into a JWT; agents get theirs through OAuth instead.
    disabledPaths: ["/token", ...DISABLED_WORKSPACE_PATHS],
    secret: env.BETTER_AUTH_SECRET,
    // Lets preview origins call /api/auth/* (origin check) and be redirect targets.
    trustedOrigins: previewOrigins(env),
    database: drizzleAdapter(createDb(env.DB), { provider: "sqlite", schema }),
    // Global role (schema.ts): "operator" sees the dashboard's Admin section. On session.user, so
    // it rides the session cookie cache. Granted by SQL only, never by the user.
    user: { additionalFields: { role: { type: "string", required: false, input: false } } },
    socialProviders: {
      github: {
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      },
    },
    databaseHooks: {
      user: {
        create: {
          // First GitHub sign-in creates the user: send the welcome email.
          after: async (user) => {
            await background(
              sendEmail(env, { to: user.email, template: "welcome", context: { name: user.name } }),
            );
          },
        },
      },
    },
    hooks: {
      // The dashboard's workspace list re-reads memberships from GitHub when they're a few
      // minutes old (src/memberships.ts), so a new install or lost access shows up without
      // signing in again.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/organization/list") return;
        const session = await getSessionFromCtx(ctx).catch(() => null);
        if (!session) return;
        await syncMembershipsFromGitHub(auth, createDb(env.DB), session.user.id).catch((error) =>
          console.error("membership sync on workspace list failed", error),
        );
      }),
      after: createAuthMiddleware(async (ctx) => {
        // Every sign-in (GitHub's callback, the install hand-off, the CLI's device code) reads the
        // user's workspaces fresh from GitHub (src/memberships.ts).
        const signedIn = ctx.context.newSession;
        if (signedIn) {
          await syncMembershipsFromGitHub(auth, createDb(env.DB), signedIn.user.id, {
            force: true,
          }).catch((error) => console.error("membership sync on sign-in failed", error));
        }
        if (ctx.path === "/device/code") {
          // Remember where the CLI asked from, for the approval page (src/device-origin.ts).
          const deviceCode = (ctx.context.returned as { device_code?: unknown } | null)
            ?.device_code;
          if (typeof deviceCode !== "string") return;
          const origin = requestOrigin(ctx.request);
          await createDb(env.DB)
            .update(schema.deviceCode)
            .set({
              requestIp: origin.ip,
              requestCountry: origin.country,
              requestCity: origin.city,
            })
            .where(eq(schema.deviceCode.deviceCode, deviceCode));
        }
      }),
    },
    advanced: cookieDomain
      ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
      : undefined,
    session: {
      // Keep a signed copy of the session in a cookie so most getSession calls skip D1.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    plugins: [
      workspaces(),
      // Sign-in from a preview: GitHub returns to the production callback, which exchanges the
      // code and redirects to <preview>/api/auth/callback/github/oauth-proxy with the profile
      // encrypted (BETTER_AUTH_SECRET). The preview then creates the session and sets the
      // cookie (shared across relayrun.workers.dev, see sharedCookieDomain). On production itself
      // the plugin steps aside.
      oAuthProxy({
        productionURL: env.BETTER_AUTH_URL,
        // Seconds the encrypted hand-off stays valid; it only has to survive one redirect.
        maxAge: 60,
      }),
      // `relayrunner connect` signs in with a device code the user approves at /device in the
      // dashboard (src/machines.ts). The CLI only holds the resulting user session long enough to
      // trade it for a machine token at POST /api/machines/claim.
      deviceAuthorization({
        verificationUri: new URL("/device", env.BETTER_AUTH_URL).toString(),
        validateClient: (clientId) => clientId === MACHINE_CLIENT_ID,
        // Short: an approval link someone else started is only good for a few minutes.
        expiresIn: "15m",
        interval: "5s",
      }),
      // Lets that claim call send the device-flow session as `Authorization: Bearer <token>`.
      bearer(),
      // Agent sign-in for the MCP server (src/agent-auth.ts). jwt signs the access tokens and
      // serves their keys at /api/auth/jwks; its own session-JWT header and /token are off, so the
      // only JWTs it hands out are agent access tokens.
      jwt({ disableSettingJwtHeader: true }),
      agentOAuth(env),
      // Signing in with the code GitHub sends after an install (routes/github.ts /setup).
      installSignIn({ setupURL: new URL("/api/github/setup", env.BETTER_AUTH_URL).toString() }),
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

// Workspaces are Better Auth organizations, stored under gateway names (workspace,
// workspace_member, session.active_workspace_id). The plugin is kept for those tables, roles and
// the active workspace; members come from GitHub (src/memberships.ts), not invites; the dashboard uses the stock organization
// client at /api/auth/organization/* to list and switch them.
export function workspaces() {
  return organization({
    // A workspace is a GitHub App installation (#316), made by the Setup URL or the installation
    // webhook (src/installations.ts ensureWorkspace), never by a user.
    allowUserToCreateOrganization: false,
    creatorRole: "owner",
    // Teams (#133): owner, admin and member roles; see roles.ts.
    membershipLimit: 100,
    schema: {
      organization: {
        modelName: "workspace",
        // Set by ensureWorkspace, never through Better Auth (creation is off).
        additionalFields: {
          installationId: { type: "number", required: true, input: false },
        },
      },
      member: { modelName: "workspaceMember", fields: { organizationId: "workspaceId" } },
      // Unused (invites are off), but the plugin requires the table.
      invitation: { modelName: "workspaceInvitation", fields: { organizationId: "workspaceId" } },
      session: { fields: { activeOrganizationId: "activeWorkspaceId" } },
    },
  });
}
