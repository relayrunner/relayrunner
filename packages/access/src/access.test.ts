import { beforeEach, describe, expect, test } from "vitest";
import { gateAdmin, isAdminPath } from "./gate.ts";
import { accessConfig, clearAccessCertsCache, verifyAccessJwt } from "./jwt.ts";

const TEAM = "relayrunner.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUD = "aud-preview";
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: `${AUD}, aud-other` };
const config = accessConfig(env)!;

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
let certFetches = 0;
const fetchCerts = async (url: string) => {
  expect(url).toBe(`${ISSUER}/cdn-cgi/access/certs`);
  certFetches++;
  return { keys: [jwk] };
};
const NOW = 1_800_000_000_000;
const options = { fetchCerts, now: () => NOW };

function b64url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(claims: Record<string, unknown>, header = { alg: "RS256", kid: "k1" }) {
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

const base = { iss: ISSUER, aud: [AUD], exp: NOW / 1000 + 300, nbf: NOW / 1000 - 10 };

beforeEach(() => {
  clearAccessCertsCache();
  certFetches = 0;
});

describe("accessConfig", () => {
  test("is null until both the team domain and an AUD are set", () => {
    expect(accessConfig({})).toBeNull();
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
    expect(accessConfig({ ACCESS_AUD: AUD })).toBeNull();
  });

  test("accepts the team domain with or without a scheme", () => {
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD })).toEqual({
      issuer: ISSUER,
      audiences: [AUD],
    });
  });
});

describe("verifyAccessJwt", () => {
  test("returns the person for a user token", async () => {
    const token = await sign({ ...base, email: "dev@example.com", sub: "u1" });
    expect(await verifyAccessJwt(token, config, options)).toEqual({
      ok: true,
      identity: { kind: "user", email: "dev@example.com", sub: "u1" },
    });
  });

  test("returns the client ID for a service token", async () => {
    const token = await sign({ ...base, common_name: "abc.access", sub: "" });
    expect(await verifyAccessJwt(token, config, options)).toEqual({
      ok: true,
      identity: { kind: "service", clientId: "abc.access" },
    });
  });

  test("accepts any configured audience", async () => {
    const token = await sign({ ...base, aud: "aud-other", email: "dev@example.com" });
    expect((await verifyAccessJwt(token, config, options)).ok).toBe(true);
  });

  test("rejects tokens for another app, issuer, or time", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ aud: ["someone-else"] }, "wrong_audience"],
      [{ iss: "https://evil.cloudflareaccess.com" }, "wrong_issuer"],
      [{ exp: NOW / 1000 - 120 }, "expired"],
      [{ nbf: NOW / 1000 + 120 }, "not_yet_valid"],
      [{ email: undefined, common_name: undefined }, "no_identity"],
    ];
    for (const [override, reason] of cases) {
      const token = await sign({ ...base, email: "dev@example.com", ...override });
      expect(await verifyAccessJwt(token, config, options)).toEqual({ ok: false, reason });
    }
  });

  test("rejects a tampered payload, other algorithms and garbage", async () => {
    const token = await sign({ ...base, email: "dev@example.com" });
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...base, email: "admin@example.com" }))}.${s}`;
    expect(await verifyAccessJwt(forged, config, options)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const hs = await sign(base, { alg: "HS256", kid: "k1" });
    expect((await verifyAccessJwt(hs, config, options)).ok).toBe(false);
    expect(await verifyAccessJwt("nope", config, options)).toEqual({
      ok: false,
      reason: "malformed_token",
    });
  });

  test("caches the key set and refetches for an unknown kid", async () => {
    const token = await sign({ ...base, email: "dev@example.com" });
    await verifyAccessJwt(token, config, options);
    await verifyAccessJwt(token, config, options);
    expect(certFetches).toBe(1);
    const rotated = await sign(base, { alg: "RS256", kid: "k2" });
    expect(await verifyAccessJwt(rotated, config, options)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
    expect(certFetches).toBe(2);
  });

  test("fails closed when the key set can't be fetched", async () => {
    const token = await sign({ ...base, email: "dev@example.com" });
    const failing = {
      now: options.now,
      fetchCerts: async () => {
        throw new Error("down");
      },
    };
    expect(await verifyAccessJwt(token, config, failing)).toEqual({
      ok: false,
      reason: "certs_unavailable",
    });
  });
});

describe("gateAdmin", () => {
  test("matches /admin and /api/admin, and nothing that merely starts with them", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/access")).toBe(true);
    expect(isAdminPath("/api/admin/webhooks")).toBe(true);
    expect(isAdminPath("/administrators")).toBe(false);
    expect(isAdminPath("/api/administer")).toBe(false);
    expect(isAdminPath("/dev")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
  });

  test("answers 404 when Access isn't configured", async () => {
    const result = await gateAdmin(new Request("https://x/admin"), {}, options);
    expect("response" in result && result.response.status).toBe(404);
  });

  test("answers 403 without a valid token", async () => {
    const result = await gateAdmin(new Request("https://x/admin"), env, options);
    expect("response" in result && result.response.status).toBe(403);
  });

  test("lets a valid token through with its identity", async () => {
    const token = await sign({ ...base, common_name: "abc.access" });
    const request = new Request("https://x/admin", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(await gateAdmin(request, env, options)).toEqual({
      identity: { kind: "service", clientId: "abc.access" },
    });
  });
});
