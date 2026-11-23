// Talking to GitHub on behalf of a signed-in user, and the signed `state` that carries a
// workspace through the GitHub App install page.

const API = "https://api.github.com";

// The slice of a GitHub App installation the gateway stores. Both GET /user/installations and
// installation webhooks send this shape.
export interface GitHubInstallation {
  id: number;
  account: { id: number; login: string; type: string } | null;
  repository_selection: "all" | "selected";
  suspended_at: string | null;
}

// Installations of this GitHub App that the user's token can see: accounts the user owns or
// administers, or where they can reach a repo the App was given. Following the user's token is
// what proves an installation_id from a query string really is theirs.
export async function listUserInstallations(token: string): Promise<GitHubInstallation[]> {
  const installations: GitHubInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${API}/user/installations?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "relayrunner-gateway",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok)
      throw new GitHubError(
        response.status,
        `GET /user/installations failed with ${response.status}`,
      );
    const body = (await response.json()) as {
      total_count: number;
      installations: GitHubInstallation[];
    };
    installations.push(...body.installations);
    if (body.installations.length < 100 || installations.length >= body.total_count)
      return installations;
  }
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The App's install page with no state: a signup, where there's no workspace or user to name yet.
export function appInstallUrl(appSlug: string) {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

export function installUrl(appSlug: string, state: string) {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

// Where an owner changes which repos the App sees, accepts new permissions, or unsuspends it.
export function installationSettingsUrl(installation: {
  id: number;
  accountLogin: string;
  accountType: string;
}) {
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;
}

// The install link's `state`: who started it, when it stops being valid, and optionally where in
// the dashboard to land afterwards (the /device page during `relayrunner connect` onboarding) and
// which origin it started on. HMAC-signed with BETTER_AUTH_SECRET so it can't be forged. It only
// steers the browser: the installation itself is checked against the user's token.
export interface InstallState {
  userId: string;
  expiresAt: number;
  next?: string;
  /** The dashboard origin the install started on, where the user's session cookie lives. */
  origin?: string;
}

// A dashboard path to send the browser back to: same-origin and path-absolute only, so `next`
// can't become an open redirect. Returns null for anything else.
export function dashboardPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  const base = "https://dashboard.invalid";
  try {
    const url = new URL(value, base);
    return url.origin === base ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

// An http(s) origin and nothing else (no path or credentials), or null.
function httpOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

const STATE_TTL_MS = 60 * 60 * 1000;

export async function signInstallState(
  secret: string,
  userId: string,
  {
    next,
    origin,
    now = Date.now(),
  }: { next?: string | null; origin?: string | null; now?: number } = {},
) {
  const fields: Record<string, unknown> = { u: userId, e: now + STATE_TTL_MS };
  if (next) fields.n = next;
  if (origin) fields.o = origin;
  const payload = base64url(new TextEncoder().encode(JSON.stringify(fields)));
  return `${payload}.${base64url(await hmac(secret, payload))}`;
}

export async function verifyInstallState(
  secret: string,
  state: string,
  now = Date.now(),
): Promise<InstallState | null> {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = base64url(await hmac(secret, payload));
  if (!timingSafeEqual(expected, signature)) return null;
  try {
    const { u, e, n, o } = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (typeof u !== "string" || typeof e !== "number" || e < now) return null;
    const next = dashboardPath(n);
    const origin = httpOrigin(o);
    return {
      userId: u,
      expiresAt: e,
      ...(next ? { next } : {}),
      ...(origin ? { origin } : {}),
    };
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`github-install-state:${data}`)),
  );
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
