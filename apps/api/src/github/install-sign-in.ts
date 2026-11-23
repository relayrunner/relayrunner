import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import * as z from "zod";

// Signs a user in with the code GitHub hands over when the App asks for user authorization
// during installation (docs/github-app.md). GitHub sends that code to the App's first callback
// URL, /api/github/setup, without a `state` we issued, so Better Auth's own callback would refuse
// it. Starting a fresh sign-in instead costs a second trip to GitHub that shows its authorize
// page again, so /api/github/setup exchanges this code here, the way Better Auth's callback
// would: same provider, same user and account records, same session cookie.
//
// Server-only: called through auth.api from /api/github/setup, never routed over HTTP. That route
// only calls it for a browser that started a signup (its cookie), so a code from someone else's
// link can't sign this browser in to their account.
export function installSignIn(options: { setupURL: string }) {
  return {
    id: "install-sign-in",
    endpoints: {
      signInFromInstall: createAuthEndpoint(
        "/github/install-sign-in",
        {
          method: "POST",
          body: z.object({ code: z.string().min(1) }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const providers = await ctx.context.socialProviders;
          const github = providers.find((provider) => provider.id === "github");
          if (!github) throw new APIError("NOT_FOUND", { message: "GitHub sign-in is off" });

          // The code was issued for the first callback URL, so the exchange names that one.
          const tokens = await github
            .validateAuthorizationCode({ code: ctx.body.code, redirectURI: options.setupURL })
            .catch(() => null);
          if (!tokens) throw new APIError("UNAUTHORIZED", { message: "invalid_code" });
          const info = await github.getUserInfo(tokens);
          if (!info?.user?.email) throw new APIError("UNAUTHORIZED", { message: "no_email" });
          const accountId = String((info.data as { id: number | string }).id);

          const result = await handleOAuthUserInfo(ctx, {
            userInfo: {
              ...info.user,
              id: accountId,
              email: info.user.email,
              name: info.user.name || "",
              emailVerified: info.user.emailVerified ?? false,
            },
            account: {
              providerId: github.id,
              accountId,
              ...tokens,
              scope: tokens.scopes?.join(","),
            },
            source: {
              method: "oauth",
              oauth: { providerId: github.id, profile: info.data as Record<string, unknown> },
            },
          });
          if (result.error || !result.data)
            throw new APIError("UNAUTHORIZED", { message: result.error ?? "sign_in_failed" });
          await setSessionCookie(ctx, result.data);
          return ctx.json({ ok: true, isRegister: !!result.isRegister });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
