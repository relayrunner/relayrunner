import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { bearer, deviceAuthorization, oAuthProxy, organization } from "better-auth/plugins";
import { recordEvent } from "./activity.ts";
import { createDb, schema } from "./db/index.ts";
import { sendEmail } from "./email.ts";
import { installSignIn } from "./install-sign-in.ts";
import { MEMBER_REMOVAL_PATHS, onMemberRemoved, removedMember } from "./members.ts";
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
  return betterAuth({
    // Always the production dashboard origin, so GitHub only ever sees one OAuth callback URL.
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
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
      // A member removed from (or leaving) a workspace loses the machines they enrolled there
      // (#138). This runs after Better Auth has deleted the membership, inline rather than on a
      // queue: one D1 update clears every token, then each open socket closes.
      after: createAuthMiddleware(async (ctx) => {
        if (!(MEMBER_REMOVAL_PATHS as readonly string[]).includes(ctx.path)) return;
        const member = removedMember(ctx.context.returned);
        if (!member) return;
        // The endpoint's session isn't on the hook's context; read it from the request again.
        // Revoke even if that somehow fails: losing the actor beats leaving machines live.
        const session = await getSessionFromCtx(ctx).catch(() => null);
        await onMemberRemoved(env, createDb(env.DB), {
          workspaceId: member.organizationId,
          userId: member.userId,
          actorUserId: session?.user.id ?? null,
          left: ctx.path === "/organization/leave",
        });
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
      workspaces(env, background),
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
        expiresIn: "30m",
        interval: "5s",
      }),
      // Lets that claim call send the device-flow session as `Authorization: Bearer <token>`.
      bearer(),
      // Signing in with the code GitHub sends after an install (routes/github.ts /setup).
      installSignIn({ setupURL: new URL("/api/github/setup", env.BETTER_AUTH_URL).toString() }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

// Workspaces are Better Auth organizations, stored under gateway names (workspace,
// workspace_member, workspace_invitation, session.active_workspace_id). The dashboard uses the
// stock organization client at /api/auth/organization/*.
export function workspaces(env: Env, background: (promise: Promise<unknown>) => unknown) {
  const db = () => createDb(env.DB);
  return organization({
    // Any signed-in user can create a workspace and becomes its owner.
    allowUserToCreateOrganization: true,
    creatorRole: "owner",
    // Teams (#133): owner, admin and member roles; see roles.ts.
    membershipLimit: 100,
    // Invites (#135). Better Auth's defaults decide who can do what: owners and admins invite
    // and cancel, only an owner can invite an owner, and accepting needs the signed-in account's
    // email to match. Invites expire after 48 hours.
    invitationExpiresIn: 48 * 60 * 60,
    // Inviting the same email again cancels the pending invite and sends a new link, so an old
    // link (say, a forwarded email) stops working.
    cancelPendingInvitationsOnReInvite: true,
    // The link opens the dashboard's accept page, /invite/<id> (#137).
    sendInvitationEmail: async ({ id, email, role, organization, inviter, invitation }) => {
      await background(
        sendEmail(env, {
          to: email,
          template: "invite",
          context: {
            invitationId: id,
            inviterName: inviter.user.name || inviter.user.email,
            workspaceName: organization.name,
            role,
            expiresAt: invitation.expiresAt,
          },
        }),
      );
    },
    organizationHooks: {
      afterCreateInvitation: async ({ invitation, inviter }) => {
        await recordEvent(db(), {
          workspaceId: invitation.organizationId,
          actorUserId: inviter.id,
          type: "member.invited",
          data: { email: invitation.email, role: invitation.role },
        });
      },
      afterCancelInvitation: async ({ invitation, cancelledBy }) => {
        await recordEvent(db(), {
          workspaceId: invitation.organizationId,
          actorUserId: cancelledBy.id,
          type: "member.invite_canceled",
          data: { email: invitation.email, role: invitation.role },
        });
      },
      afterAcceptInvitation: async ({ member, user }) => {
        await recordEvent(db(), {
          workspaceId: member.organizationId,
          actorUserId: user.id,
          type: "member.joined",
          data: { name: user.name, email: user.email, role: member.role },
        });
      },
    },
    schema: {
      organization: { modelName: "workspace" },
      member: { modelName: "workspaceMember", fields: { organizationId: "workspaceId" } },
      invitation: { modelName: "workspaceInvitation", fields: { organizationId: "workspaceId" } },
      session: { fields: { activeOrganizationId: "activeWorkspaceId" } },
    },
  });
}
