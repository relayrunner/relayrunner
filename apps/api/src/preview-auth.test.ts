import { readdirSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import { app } from "./app.ts";
import { sharedCookieDomain } from "./auth.ts";
import type { Env } from "./env.ts";

// Sign-in from a dashboard preview, end to end through the oAuthProxy plugin, with GitHub's OAuth
// endpoints stubbed. Uses the vars from wrangler.jsonc (production BETTER_AUTH_URL and
// PREVIEW_ORIGINS) and a real in-memory D1.
const production = "https://relayrunner-app.relayrun.workers.dev";
const preview = "https://feature-x-relayrunner-app.relayrun.workers.dev";
// The interim custom domain signs in the same way until BETTER_AUTH_URL moves to it.
const customDomain = "https://app.relayrunner.app";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let env: Env;

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({
    configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    persist: false,
  });
  env = {
    ...proxy.env,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_APP_CLIENT_ID: "id",
    GITHUB_APP_CLIENT_SECRET: "secret",
  };
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(file, dir), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) await env.DB.prepare(statement).run();
    }
  }
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubGitHub() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.href === "https://github.com/login/oauth/access_token") {
      return json({
        access_token: "gho_test",
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (url.href === "https://api.github.com/user") {
      return json({
        id: 4242,
        login: "octo",
        name: "Octo Cat",
        email: null,
        avatar_url: "https://example.com/a.png",
      });
    }
    if (url.href === "https://api.github.com/user/emails") {
      return json([{ email: "octo@example.com", primary: true, verified: true }]);
    }
    return realFetch(input, init);
  });
}

function cookiesFrom(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function startSignIn(origin: string) {
  return app.request(
    `${origin}/api/auth/sign-in/social`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "github", callbackURL: "/runners" }),
    },
    env,
  );
}

describe("preview sign-in", () => {
  test.each([
    ["a preview", preview],
    ["the custom domain", customDomain],
  ])(
    "%s signs in through the production callback and gets its own session cookie",
    async (_, preview) => {
      // 1. The preview starts sign-in. GitHub must be told to return to production.
      const started = await startSignIn(preview);
      expect(started.status).toBe(200);
      const { url } = (await started.json()) as { url: string };
      const authorize = new URL(url);
      expect(authorize.origin).toBe("https://github.com");
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        `${production}/api/auth/callback/github`,
      );
      const state = authorize.searchParams.get("state");
      expect(state).toBeTruthy();

      // 2. GitHub redirects to production, which exchanges the code and hands off to the preview.
      stubGitHub();
      const callback = await app.request(
        `${production}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state!)}`,
        {},
        env,
      );
      expect(callback.status).toBe(302);
      const handoff = new URL(callback.headers.get("location")!);
      expect(handoff.origin).toBe(preview);
      expect(handoff.pathname).toBe("/api/auth/callback/github/oauth-proxy");
      expect(handoff.searchParams.get("profile")).toBeTruthy();
      // Production must not have signed anyone in on its own host.
      expect(
        callback.headers.getSetCookie().some((cookie) => cookie.includes("session_token")),
      ).toBe(false);

      // 3. The preview completes the hand-off, sets its session cookie, and lands on the app.
      const completed = await app.request(
        handoff.href,
        { headers: { cookie: cookiesFrom(started) } },
        env,
      );
      expect(completed.status).toBe(302);
      expect(completed.headers.get("location")).toBe("/runners");
      const cookie = cookiesFrom(completed);
      expect(cookie).toContain("session_token");
      // Previews share the cookie across relayrun.workers.dev, so one sign-in covers every preview
      // URL. The custom domain keeps a host-only cookie.
      const sessionCookie = completed.headers
        .getSetCookie()
        .find((set) => set.includes("session_token"))!;
      expect(/domain=([^;]+)/i.exec(sessionCookie)?.[1]).toBe(
        preview === customDomain ? undefined : "relayrun.workers.dev",
      );

      const session = await app.request(
        `${preview}/api/auth/get-session`,
        { headers: { cookie } },
        env,
      );
      expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
        "octo@example.com",
      );
    },
  );

  test("an untrusted host never receives the hand-off", async () => {
    // Better Auth skips its Origin/CSRF check under vitest (and only enforces it when cookies are
    // sent), so this checks the plugin's own guard: an untrusted request host is never used as the
    // hand-off target, the profile goes back to production instead.
    const evil = "https://feature-x-relayrunner-app.evil.workers.dev";
    const started = await startSignIn(evil);
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get(
      "state",
    )!;
    stubGitHub();
    const callback = await app.request(
      `${production}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`,
      {},
      env,
    );
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!, production).origin).toBe(production);
  });

  test("a replayed hand-off is refused once it is older than a minute", async () => {
    const started = await startSignIn(preview);
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get(
      "state",
    )!;
    stubGitHub();
    const callback = await app.request(
      `${production}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`,
      {},
      env,
    );
    const handoff = callback.headers.get("location")!;

    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    try {
      const completed = await app.request(handoff, {}, env);
      expect(completed.status).toBe(302);
      expect(completed.headers.get("location")).toContain("error=payload_expired");
      expect(cookiesFrom(completed)).not.toContain("session_token");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sharedCookieDomain", () => {
  const env = { SESSION_COOKIE_DOMAIN: "relayrun.workers.dev" };
  test.each([
    ["relayrunner-app.relayrun.workers.dev", "relayrun.workers.dev"],
    ["feature-x-relayrunner-app.relayrun.workers.dev", "relayrun.workers.dev"],
    ["relayrun.workers.dev", undefined],
    ["evilrelayrun.workers.dev", undefined],
    ["relayrun.workers.dev.evil.com", undefined],
    ["app.relayrunner.app", undefined],
    ["localhost", undefined],
  ])("%s -> %s", (host, expected) => {
    expect(sharedCookieDomain(env, host)).toBe(expected);
  });

  test("is off without SESSION_COOKIE_DOMAIN", () => {
    expect(sharedCookieDomain({}, "relayrunner-app.relayrun.workers.dev")).toBeUndefined();
  });
});
