import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { authorizationCodeRequest, getOAuth2Tokens } from "better-auth/oauth2";

// GitHub's token endpoint sometimes answers a sign-in's code exchange with HTTP 429 ("Access to
// this site has been restricted"), most likely because Cloudflare's outbound IP is shared with
// other busy Workers. Better Auth reports every failed exchange as invalid_code. This plugin swaps
// in the same exchange GitHub's provider makes, but waits and tries once more on a 429 (GitHub
// turned the request away, so the code is still good), and if GitHub is still busy, sends the
// browser to /login?error=github_busy so the page can say so and try again on its own.
//
// The auth instance is built per request (auth.ts), so `busy` belongs to this one request.

const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
export const GITHUB_BUSY = "github_busy";

type Exchange = {
  code: string;
  codeVerifier?: string;
  redirectURI: string;
};

export function githubBusy(options: { retryDelayMs?: number } = {}) {
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let busy = false;

  return {
    id: "github-busy",
    init(ctx) {
      const github = ctx.socialProviders.find((provider) => provider.id === "github");
      if (!github) return;
      github.validateAuthorizationCode = async ({ code, codeVerifier, redirectURI }: Exchange) => {
        const { body, headers } = await authorizationCodeRequest({
          code,
          codeVerifier,
          redirectURI,
          options: github.options ?? {},
        });
        const post = () =>
          fetch(TOKEN_ENDPOINT, { method: "POST", body, headers, redirect: "manual" });
        let response = await post();
        if (response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          response = await post();
        }
        if (response.status === 429) {
          busy = true;
          ctx.logger.error("GitHub OAuth token exchange rate-limited (429)");
          return null;
        }
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || !data || "error" in data) {
          ctx.logger.error("GitHub OAuth token exchange failed:", data ?? response.status);
          return null;
        }
        return getOAuth2Tokens(data);
      };
    },
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/callback/:id",
          handler: createAuthMiddleware(async (ctx) => {
            if (!busy) return;
            const location = ctx.context.responseHeaders?.get("location");
            if (!location?.includes("error=invalid_code")) return;
            ctx.setHeader(
              "location",
              location.replace("error=invalid_code", `error=${GITHUB_BUSY}`),
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
