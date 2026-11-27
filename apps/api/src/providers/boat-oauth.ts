// "Sign in with boat" (https://docs.boat.dev/oauth-apps): connecting a workspace's Boat account in
// one click instead of pasting an API key. The workspace's provider_connection row then holds a
// sealed grant (access token, refresh token, expiry) instead of a key, and every reader asks
// connectionBearer for a token that works now.
//
// We ask only for account.read, which covers /me, /limits and /ci: who the account is, its plan and
// start limits, and where Boat's CI GitHub App is installed. It can't install the app, start a plan
// or change anything.
//
// Boat rotates the refresh token on every refresh, ends the connection if it sees an old one again
// after a minute, and ends it too when two refreshes of the same connection overlap. So one caller
// at a time refreshes: it claims the row first (a compare-and-swap on the sealed token, which a
// random IV makes unique), and the others wait for its answer. A claim lasts LEASE_MS, so a caller
// that died mid-refresh doesn't strand the row; the next one sends the same refresh token again,
// which Boat answers within a minute.
import { and, eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { ProviderAuthError, ProviderApiError } from "../provider-billing/types.ts";
import { openToken, sealToken } from "./provider-tokens.ts";

const AUTHORIZE_URL = "https://boat.dev/api/boat/oauth2/authorize";
const TOKEN_URL = "https://boat.dev/api/boat/oauth2/token";
export const BOAT_SCOPE = "account.read";
/** Where Boat sends the browser back, on the dashboard's own origin. Registered with the app. */
export const CALLBACK_PATH = "/api/providers/boat/callback";

// Refresh this long before Boat's expiry, so a token never runs out mid-request.
const EARLY_MS = 2 * 60_000;
// How long a claim to refresh holds.
const LEASE_MS = 30_000;
// How long a caller that lost the claim waits for the winner's answer, and how often it looks.
const WAIT_MS = 4_000;
const POLL_MS = 250;
const TIMEOUT_MS = 20_000;

/** A Boat OAuth grant, as sealed in provider_connection.token. A pasted key is a bare string. */
export interface BoatGrant {
  kind: "boat-oauth";
  access: string;
  refresh: string;
  /** Epoch ms the access token stops working. */
  expiresAt: number;
  /** Epoch ms until which one caller is refreshing; absent when nobody is. */
  leaseUntil?: number;
}

export type OAuthEnv = Pick<
  Env,
  "BOAT_OAUTH_CLIENT_ID" | "BOAT_OAUTH_CLIENT_SECRET" | "BETTER_AUTH_URL" | "PROVIDER_TOKEN_KEY"
>;

/** Whether this deployment has a Boat OAuth app to send people to. */
export const boatOAuthConfigured = (env: Pick<Env, "BOAT_OAUTH_CLIENT_ID">) =>
  !!env.BOAT_OAUTH_CLIENT_ID;

/** The registered redirect URI: always the production dashboard, whichever host started. */
export const callbackUrl = (env: Pick<Env, "BETTER_AUTH_URL">) =>
  `${new URL(env.BETTER_AUTH_URL).origin}${CALLBACK_PATH}`;

/** The grant inside an opened token, or null for a pasted key. */
export function parseGrant(opened: string): BoatGrant | null {
  if (!opened.startsWith("{")) return null;
  try {
    const value = JSON.parse(opened) as Partial<BoatGrant>;
    return value.kind === "boat-oauth" &&
      typeof value.access === "string" &&
      typeof value.refresh === "string" &&
      typeof value.expiresAt === "number"
      ? (value as BoatGrant)
      : null;
  } catch {
    return null;
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A PKCE verifier and its S256 challenge, plus a random state. */
export async function pkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64url(new Uint8Array(digest)),
    state: base64url(crypto.getRandomValues(new Uint8Array(24))),
  };
}

export function authorizeUrl(
  env: Pick<Env, "BOAT_OAUTH_CLIENT_ID" | "BETTER_AUTH_URL">,
  { challenge, state }: { challenge: string; state: string },
): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.BOAT_OAUTH_CLIENT_ID ?? "",
    redirect_uri: callbackUrl(env),
    scope: BOAT_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function tokenRequest(
  env: OAuthEnv,
  params: Record<string, string>,
  fetcher: typeof fetch,
  now: number,
): Promise<BoatGrant> {
  const secret = env.BOAT_OAUTH_CLIENT_SECRET ? await env.BOAT_OAUTH_CLIENT_SECRET.get() : "";
  const body = new URLSearchParams({
    ...params,
    client_id: env.BOAT_OAUTH_CLIENT_ID ?? "",
    ...(secret && { client_secret: secret }),
  });
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = (await response.json().catch(() => ({}))) as TokenAnswer;
  if (!response.ok) {
    const reason = `Boat: ${String(answer.error ?? response.status)}${
      answer.error_description ? ` (${String(answer.error_description)})` : ""
    }`;
    // A used, expired or revoked grant needs the person to connect again; anything else may pass.
    if (answer.error === "invalid_grant" || answer.error === "invalid_client")
      throw new ProviderAuthError(reason);
    throw new ProviderApiError(reason);
  }
  if (typeof answer.access_token !== "string" || typeof answer.refresh_token !== "string")
    throw new ProviderApiError("Boat's token answer had no tokens");
  const seconds = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
  return {
    kind: "boat-oauth",
    access: answer.access_token,
    refresh: answer.refresh_token,
    expiresAt: now + seconds * 1000,
  };
}

/** Trade the code Boat sent back for a grant. */
export function exchangeCode(
  env: OAuthEnv,
  { code, verifier }: { code: string; verifier: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<BoatGrant> {
  return tokenRequest(
    env,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(env),
      code_verifier: verifier,
    },
    fetcher,
    now,
  );
}

const fresh = (grant: BoatGrant, now: number) => grant.expiresAt - EARLY_MS > now;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The bearer token a connection's API calls use now: a pasted key as it is, or a grant's access
 * token, refreshed first when it's about to run out. Throws ProviderAuthError when Boat refuses the
 * refresh (the person must connect again) and ProviderApiError when it can't say right now.
 */
export async function connectionBearer(
  env: OAuthEnv,
  db: Db,
  workspaceId: string,
  provider: string,
  sealed: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const opened = await openToken(env, workspaceId, provider, sealed);
  const grant = parseGrant(opened);
  if (!grant) return opened;
  if (fresh(grant, now())) return grant.access;
  return refreshGrant(env, db, workspaceId, provider, sealed, grant, fetcher, now);
}

const where = (workspaceId: string, provider: string, token: string) =>
  and(
    eq(schema.providerConnection.workspaceId, workspaceId),
    eq(schema.providerConnection.provider, provider),
    eq(schema.providerConnection.token, token),
  );

async function refreshGrant(
  env: OAuthEnv,
  db: Db,
  workspaceId: string,
  provider: string,
  sealed: string,
  grant: BoatGrant,
  fetcher: typeof fetch,
  now: () => number,
): Promise<string> {
  const claimable = !grant.leaseUntil || grant.leaseUntil <= now();
  if (claimable) {
    const claim = await sealToken(
      env,
      workspaceId,
      provider,
      JSON.stringify({
        ...grant,
        leaseUntil: now() + LEASE_MS,
      } satisfies BoatGrant),
    );
    const claimed = await db
      .update(schema.providerConnection)
      .set({ token: claim })
      .where(where(workspaceId, provider, sealed))
      .returning({ token: schema.providerConnection.token });
    if (claimed.length === 1) {
      const next = await tokenRequest(
        env,
        { grant_type: "refresh_token", refresh_token: grant.refresh },
        fetcher,
        now(),
      ).catch(async (error: unknown) => {
        // Let the next caller try at once, unless Boat ended the grant.
        if (!(error instanceof ProviderAuthError))
          await db
            .update(schema.providerConnection)
            .set({ token: sealed })
            .where(where(workspaceId, provider, claim));
        throw error;
      });
      await db
        .update(schema.providerConnection)
        .set({ token: await sealToken(env, workspaceId, provider, JSON.stringify(next)) })
        .where(where(workspaceId, provider, claim));
      return next.access;
    }
  }
  // Someone else is refreshing: wait for their answer.
  const deadline = now() + WAIT_MS;
  while (now() < deadline) {
    await sleep(POLL_MS);
    const [row] = await db
      .select({ token: schema.providerConnection.token })
      .from(schema.providerConnection)
      .where(
        and(
          eq(schema.providerConnection.workspaceId, workspaceId),
          eq(schema.providerConnection.provider, provider),
        ),
      )
      .limit(1);
    if (!row) throw new ProviderAuthError("Boat was disconnected");
    if (row.token === sealed && grant.leaseUntil && grant.leaseUntil > now()) continue;
    const latest = parseGrant(await openToken(env, workspaceId, provider, row.token));
    if (!latest) return openToken(env, workspaceId, provider, row.token);
    if (fresh(latest, now())) return latest.access;
    // The winner gave up (its claim was released or ran out): try for it ourselves.
    if (!latest.leaseUntil || latest.leaseUntil <= now())
      return refreshGrant(env, db, workspaceId, provider, row.token, latest, fetcher, now);
  }
  // Still being refreshed. The old access token may have a little life left.
  if (grant.expiresAt > now()) return grant.access;
  throw new ProviderApiError("Boat's token is being refreshed; try again in a moment");
}
