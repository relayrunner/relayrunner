// Talking to GitHub as the RelayRunner App: App JWTs, installation tokens, the App's installations
// and the token's rate limits. Signed-in-user calls live in github.ts; the request core in
// github-api.ts.

import { deleteIfPresent, getJson, getJsonOrNull, sendJson } from "./github-api.ts";

/**
 * Import the App's private key for RS256. Accepts PKCS#8 (`BEGIN PRIVATE KEY`) or GitHub's own
 * PKCS#1 download (`BEGIN RSA PRIVATE KEY`), with or without its line breaks, since a key pasted
 * into the Secrets Store dashboard can come through either way.
 */
export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----(BEGIN|END)[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs1 ? pkcs1ToPkcs8(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }
function pkcs1ToPkcs8(pkcs1: Uint8Array) {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const key = der(0x04, pkcs1);
  return der(0x30, new Uint8Array([...version, ...rsaEncryption, ...key]));
}

function der(tag: number, content: Uint8Array) {
  const length =
    content.length < 0x80
      ? [content.length]
      : (() => {
          const bytes: number[] = [];
          for (let n = content.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
          return [0x80 | bytes.length, ...bytes];
        })();
  return new Uint8Array([tag, ...length, ...content]);
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const jsonBase64Url = (value: unknown) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

/** A short-lived JWT that authenticates as the App itself. */
export async function appJwt(appId: string, key: CryptoKey, now = Date.now()) {
  // Backdated a minute for clock drift; GitHub caps the lifetime at 10 minutes.
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${jsonBase64Url({ alg: "RS256", typ: "JWT" })}.${jsonBase64Url({ iat: issuedAt, exp: issuedAt + 540, iss: appId })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function mintInstallationToken(jwt: string, installationId: number) {
  const body = await sendJson<{ token: string; expires_at?: string }>(
    jwt,
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    undefined,
  );
  // GitHub's tokens last an hour; assume that if it doesn't say.
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 60 * 60_000;
  return { token: body.token, expiresAt };
}

type AppCredentials = { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: { get(): Promise<string> } };

/** A JWT for the main App, from its id and private key. */
export async function mainAppJwt(env: AppCredentials) {
  const key = await importAppPrivateKey(await env.GITHUB_APP_PRIVATE_KEY.get());
  return appJwt(env.GITHUB_APP_ID, key);
}

/** An installation token from the App's id and private key, as the Durable Objects hold them. */
export async function appInstallationToken(
  env: AppCredentials,
  installationId: number,
  now = Date.now(),
) {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt - now > TOKEN_REUSE_MARGIN_MS) return cached.token;
  // Callers that miss together share one mint.
  let minting = mintingTokens.get(installationId);
  if (!minting) {
    minting = (async () => mintInstallationToken(await mainAppJwt(env), installationId))();
    mintingTokens.set(installationId, minting);
    minting
      .then((minted) => installationTokens.set(installationId, minted))
      .catch(() => {})
      .finally(() => mintingTokens.delete(installationId));
  }
  return (await minting).token;
}

// Installation tokens by installation id, kept for the isolate's life so a page load or pick
// doesn't read the private key, sign a JWT and mint a token each time (each mint is a GitHub
// round trip, and the App can mint only so many an hour). Reused until 5 minutes before expiry.
const installationTokens = new Map<number, { token: string; expiresAt: number }>();

const mintingTokens = new Map<number, Promise<{ token: string; expiresAt: number }>>();

const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

/** Forget cached installation tokens. For tests. */
export function clearInstallationTokens() {
  installationTokens.clear();
  mintingTokens.clear();
}

/** The App's installation on a repo, or null when the App isn't installed there. */
export async function repoInstallationId(jwt: string, repo: string): Promise<number | null> {
  return (await getJsonOrNull<{ id: number }>(jwt, `/repos/${repo}/installation`))?.id ?? null;
}

/**
 * The slugs of every GitHub App installed on an org, ours included. Needs the org Administration
 * read permission, which the App asks for (#335).
 */
export async function orgAppSlugs(token: string, org: string) {
  const slugs: string[] = [];
  for (let page = 1; ; page++) {
    const path = `/orgs/${encodeURIComponent(org)}/installations?per_page=100&page=${page}`;
    const { installations } = await getJson<{ installations: { app_slug: string }[] }>(token, path);
    slugs.push(...installations.map((installation) => installation.app_slug));
    if (installations.length < 100) return slugs;
  }
}

/** An installation as GET /app/installations lists it. */
export interface AppInstallation {
  id: number;
  // An enterprise account has a `slug` and `name` where others have a `login`.
  account: { id: number; login?: string; slug?: string; type?: string } | null;
  // "Organization", "User" or "Enterprise".
  target_type?: string;
  suspended_at: string | null;
}

/** Every installation of the App, from its JWT. */
export async function listAppInstallations(jwt: string) {
  const installations: AppInstallation[] = [];
  for (let page = 1; ; page++) {
    const batch = await getJson<AppInstallation[]>(
      jwt,
      `/app/installations?per_page=100&page=${page}`,
    );
    installations.push(...batch);
    if (batch.length < 100) return installations;
  }
}

/** One installation of the App, from its JWT. Null when GitHub has no such installation. */
export async function getAppInstallation(jwt: string, installationId: number) {
  return getJsonOrNull<AppInstallation>(jwt, `/app/installations/${installationId}`);
}

/** Uninstall the App from an account, as the App. Already gone (404) counts as done. */
export async function deleteInstallation(env: AppCredentials, installationId: number) {
  await deleteIfPresent(await mainAppJwt(env), `/app/installations/${installationId}`);
}

/** One rate limit bucket from GET /rate_limit. `reset` is when the window starts over. */
export interface RateLimitBucket {
  limit: number;
  used: number;
  remaining: number;
  reset: Date;
}

/** The buckets the dashboard shows. A bucket GitHub didn't send is null. */
export interface RateLimits {
  core: RateLimitBucket | null;
  graphql: RateLimitBucket | null;
  actionsRunnerRegistration: RateLimitBucket | null;
}

type RawBucket = { limit: number; used: number; remaining: number; reset: number };

/**
 * The token's primary rate limits. GET /rate_limit doesn't count against them. GitHub doesn't
 * report secondary limits anywhere.
 */
export async function rateLimits(token: string): Promise<RateLimits> {
  const { resources = {} } = await getJson<{
    resources?: Record<string, RawBucket | undefined>;
  }>(token, "/rate_limit");
  const bucket = (raw: RawBucket | undefined): RateLimitBucket | null =>
    raw
      ? {
          limit: raw.limit,
          used: raw.used,
          remaining: raw.remaining,
          reset: new Date(raw.reset * 1000),
        }
      : null;
  return {
    core: bucket(resources.core),
    graphql: bucket(resources.graphql),
    actionsRunnerRegistration: bucket(resources.actions_runner_registration),
  };
}
