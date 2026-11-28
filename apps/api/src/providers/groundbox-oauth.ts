// "Connect with Groundbox" (https://groundbox.dev/docs/connect-with-groundbox): connecting a
// workspace's Groundbox team in one trip instead of making and pasting an API key. The person signs
// in to Groundbox (or creates an account on the way), picks the team and approves; Groundbox sends
// back a code that we trade for an ordinary `gbx_` API key with the scopes asked for here.
//
// The key doesn't expire and has no refresh token, so it's saved through connectProvider exactly
// like a pasted key, and everything that reads the Groundbox connection works on it unchanged.
// Groundbox's OAuth clients are public (PKCE, no client secret).
import { and, eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { log } from "../log.ts";
import { openToken } from "./provider-tokens.ts";

const AUTHORIZE_URL = "https://api.groundbox.dev/oauth/authorize";
const TOKEN_URL = "https://api.groundbox.dev/oauth/token";
const REVOKE_URL = "https://api.groundbox.dev/oauth/revoke";
/** The same two scopes the paste-a-key help asks for (BILLING_PROVIDERS.groundbox.scopes). */
export const GROUNDBOX_SCOPE = "account:read billing:read";
/** Where Groundbox sends the browser back, on the dashboard's own origin. Registered with the app. */
export const CALLBACK_PATH = "/api/providers/groundbox/callback";
/** The connection's token hint when the key came from "Connect with Groundbox", not a paste. */
export const GROUNDBOX_SIGN_IN_HINT = "Groundbox sign-in";

const TIMEOUT_MS = 20_000;

/** Whether this deployment has a Groundbox OAuth app to send people to. */
export const groundboxOAuthConfigured = (env: Pick<Env, "GROUNDBOX_OAUTH_CLIENT_ID">) =>
  !!env.GROUNDBOX_OAUTH_CLIENT_ID;

/** The registered redirect URI: always the production dashboard, whichever host started. */
export const callbackUrl = (env: Pick<Env, "BETTER_AUTH_URL">) =>
  `${new URL(env.BETTER_AUTH_URL).origin}${CALLBACK_PATH}`;

export function authorizeUrl(
  env: Pick<Env, "GROUNDBOX_OAUTH_CLIENT_ID" | "BETTER_AUTH_URL">,
  { challenge, state }: { challenge: string; state: string },
): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.GROUNDBOX_OAUTH_CLIENT_ID ?? "",
    redirect_uri: callbackUrl(env),
    scope: GROUNDBOX_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Trade the code Groundbox sent back for the team's API key. Throws when Groundbox refuses. */
export async function exchangeCode(
  env: Pick<Env, "GROUNDBOX_OAUTH_CLIENT_ID" | "BETTER_AUTH_URL">,
  { code, verifier }: { code: string; verifier: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(env),
      client_id: env.GROUNDBOX_OAUTH_CLIENT_ID ?? "",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  if (!response.ok || typeof answer.access_token !== "string")
    throw new Error(
      `Groundbox: ${String(answer.error ?? response.status)}${
        answer.error_description ? ` (${String(answer.error_description)})` : ""
      }`,
    );
  return answer.access_token;
}

/** The workspace's Groundbox key when "Connect with Groundbox" made it; null for a pasted key or none. */
export async function signInKey(env: Env, db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ token: schema.providerConnection.token, hint: schema.providerConnection.tokenHint })
    .from(schema.providerConnection)
    .where(
      and(
        eq(schema.providerConnection.workspaceId, workspaceId),
        eq(schema.providerConnection.provider, "groundbox"),
      ),
    )
    .limit(1);
  if (!row || row.hint !== GROUNDBOX_SIGN_IN_HINT) return null;
  return openToken(env, workspaceId, "groundbox", row.token);
}

/** End a key at Groundbox (RFC 7009: Groundbox answers 200 whatever the key). Never throws. */
export async function revokeKey(key: string, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    await fetcher(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: key }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    log.warn("provider.groundbox_revoke_failed", "groundbox key revoke failed", { error });
  }
}

/**
 * Before the workspace forgets its Groundbox connection: end the key at Groundbox too, when
 * "Connect with Groundbox" made it. A pasted key is the person's own and stays as it is. Never
 * throws: the connection is removed here either way.
 */
export async function revokeSignInKey(
  env: Env,
  db: Db,
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const key = await signInKey(env, db, workspaceId).catch((error: unknown) => {
    log.warn("provider.groundbox_key_unreadable", "groundbox key unreadable", {
      workspaceId,
      error,
    });
    return null;
  });
  if (key) await revokeKey(key, fetcher);
}
