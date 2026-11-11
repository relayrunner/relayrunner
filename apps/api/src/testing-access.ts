import { vi } from "vitest";

// Test helpers for Access-gated routes: a fake Zero Trust team whose certs `fetch` serves, and
// JWTs signed by it. Importing this module stubs the global fetch for the certs URL.
const ACCESS_TEAM = "relayrunner.cloudflareaccess.com";
const ACCESS_AUD = "aud-preview";
export const accessEnv = { ACCESS_TEAM_DOMAIN: ACCESS_TEAM, ACCESS_AUD };

const { privateKey, publicKey } = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };

function b64url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A valid Access JWT for the fake team, as Access sends it in `Cf-Access-Jwt-Assertion`. */
export async function accessJwt() {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://${ACCESS_TEAM}`,
    aud: [ACCESS_AUD],
    exp: now + 300,
    common_name: "agent",
  };
  const body = `${b64url(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === `https://${ACCESS_TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  return realFetch(input, init);
});
