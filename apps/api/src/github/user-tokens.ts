/**
 * GitHub user tokens: the ones a person's RelayRunner sign-in holds, which act as them (their
 * personal account's billing, their installations and memberships).
 *
 * They last 8 hours. Better Auth renews one through its refresh token when it runs out, but GitHub's
 * token endpoint answers a refused renewal (a revoked authorization, a refresh token already used)
 * with HTTP 200 and an `error` in the body, and Better Auth only checks the status: it saves nothing
 * and hands back the old, expired token, which GitHub then answers with 401 "Bad credentials".
 * `refreshGitHubToken` makes the same request and throws when the body is an error, so
 * getAccessToken fails the way it means to (userGitHubToken reads that as "no token") and the log
 * says why GitHub refused.
 */
import { and, eq } from "drizzle-orm";
import { getOAuth2Tokens, refreshAccessTokenRequest, type OAuth2Tokens } from "better-auth/oauth2";
import { type Db, schema } from "../db/index.ts";
import { log } from "../log.ts";

const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

/** GitHub refused to renew a user token. `reason` is GitHub's `error`, e.g. bad_refresh_token. */
export class GitHubRefreshError extends Error {
  constructor(readonly reason: string) {
    super(`GitHub refused the token refresh: ${reason}`);
    this.name = "GitHubRefreshError";
  }
}

/** The GitHub provider's `refreshAccessToken` for Better Auth (src/auth/auth.ts). */
export function refreshGitHubToken(
  options: { clientId: string; clientSecret: string },
  fetcher: typeof fetch = fetch,
) {
  return async (refreshToken: string): Promise<OAuth2Tokens> => {
    const { body, headers } = await refreshAccessTokenRequest({
      refreshToken,
      options,
      tokenEndpoint: TOKEN_ENDPOINT,
    });
    const response = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      body,
      headers,
      redirect: "manual",
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !data || typeof data.error === "string" || !data.access_token) {
      const reason = typeof data?.error === "string" ? data.error : `http_${response.status}`;
      // A person's sign-in that has to be redone, not a fault: warn, so it doesn't open an Issue.
      log.warn("github.token_refresh_refused", "GitHub refused a user token refresh", {
        reason,
        status: response.status,
      });
      throw new GitHubRefreshError(reason);
    }
    return getOAuth2Tokens(data);
  };
}

/**
 * Whether a token getAccessToken handed back has run out: it renews one within 5 seconds of
 * expiring, so a token still past its expiry means the renewal didn't happen. No expiry means
 * the token doesn't expire.
 */
export function isExpired(expiresAt: Date | string | null | undefined, now = Date.now()) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now;
}

/**
 * Forget a person's GitHub tokens after they revoked the App's authorization: they no longer
 * work, and without them every read that needs them says "sign in again" at once instead of when
 * the access token next expires. Their RelayRunner sessions stay; signing in gets new tokens.
 */
export async function forgetGitHubTokens(db: Db, githubUserId: number) {
  const forgotten = await db
    .update(schema.account)
    .set({
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.account.providerId, "github"),
        eq(schema.account.accountId, String(githubUserId)),
      ),
    )
    .returning({ userId: schema.account.userId });
  return forgotten.length;
}
