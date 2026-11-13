// Encryption for the read-only provider tokens workspaces paste (provider_connection.token).
// AES-256-GCM with a key from the Secrets Store (PROVIDER_TOKEN_KEY, 32 random bytes, base64), so
// a copy of the database alone can't use them. Each ciphertext is bound to its workspace and
// provider as additional data, so one row's token can't be moved onto another, and carries the key
// version it was sealed with so the key can be rotated later without a flag day.
//
// Create the key once:
//   openssl rand -base64 32 | wrangler secrets-store secret create eac3493b9fef4234a832f5f3fdcc8a41 \
//     --name PROVIDER_TOKEN_KEY --scopes workers
import type { Env } from "./env.ts";

const KEY_VERSION = 1;

/** The key isn't configured, or isn't 32 bytes. Saving or reading a token can't work. */
export class TokenKeyError extends Error {}

const keys = new WeakMap<object, Promise<CryptoKey>>();

function importKey(env: Pick<Env, "PROVIDER_TOKEN_KEY">): Promise<CryptoKey> {
  const secret = env.PROVIDER_TOKEN_KEY;
  if (!secret) return Promise.reject(new TokenKeyError("PROVIDER_TOKEN_KEY isn't bound"));
  let key = keys.get(secret);
  if (!key) {
    key = secret.get().then(
      (base64) => {
        const raw = fromBase64(base64.trim());
        if (raw.byteLength !== 32) throw new TokenKeyError("PROVIDER_TOKEN_KEY must be 32 bytes");
        return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
      },
      (error: unknown) => {
        throw new TokenKeyError(`PROVIDER_TOKEN_KEY: ${String(error)}`);
      },
    );
    // A failed read is retried on the next call rather than cached.
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

const additionalData = (workspaceId: string, provider: string) =>
  new TextEncoder().encode(`${workspaceId}:${provider}`);

export async function sealToken(
  env: Pick<Env, "PROVIDER_TOKEN_KEY">,
  workspaceId: string,
  provider: string,
  token: string,
): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(workspaceId, provider) },
    key,
    new TextEncoder().encode(token),
  );
  return `v${KEY_VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

export async function openToken(
  env: Pick<Env, "PROVIDER_TOKEN_KEY">,
  workspaceId: string,
  provider: string,
  sealed: string,
): Promise<string> {
  const [version, iv, data] = sealed.split(".");
  if (version !== `v${KEY_VERSION}` || !iv || !data) throw new Error("unknown token format");
  const key = await importKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: additionalData(workspaceId, provider) },
    key,
    fromBase64(data),
  );
  return new TextDecoder().decode(plain);
}

/** The last four characters, for the dashboard to show which token is saved. */
export const tokenHint = (token: string) => token.slice(-4);

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64(text: string) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
