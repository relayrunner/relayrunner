import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import type { Env } from "./env.ts";
import { createTestEnv } from "./testing.ts";

// A GitHub sign-in that fails on the way back lands on the dashboard's sign-in page with the
// error code (auth.ts onAPIError), never on Better Auth's own error page.
const production = "https://app.relayrunner.app";

let env: Env;

beforeAll(async () => {
  env = await createTestEnv({ env: { BETTER_AUTH_URL: production } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// GitHub refuses the code, as it does for one that was already used or has expired.
function stubRefusedCode() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === "https://github.com/login/oauth/access_token") {
      return Response.json({ error: "bad_verification_code" });
    }
    return realFetch(input, init);
  });
}

async function startSignIn(body: Record<string, string>) {
  const started = await app.request(
    `${production}/api/auth/sign-in/social`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: production },
      body: JSON.stringify({ provider: "github", callbackURL: "/runners", ...body }),
    },
    env,
  );
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const cookie = started.headers
    .getSetCookie()
    .map((set) => set.split(";")[0])
    .join("; ");
  return { state, cookie };
}

function callback(state: string, cookie: string) {
  return app.request(
    `${production}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { cookie } },
    env,
  );
}

describe("sign-in errors", () => {
  test("a refused code goes back to the sign-in page", async () => {
    const { state, cookie } = await startSignIn({});
    stubRefusedCode();
    const response = await callback(state, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?error=invalid_code");
  });

  test("the sign-in button's errorCallbackURL keeps where to go next", async () => {
    const { state, cookie } = await startSignIn({ errorCallbackURL: "/login?redirect=%2Fdevice" });
    stubRefusedCode();
    const response = await callback(state, cookie);
    expect(response.headers.get("location")).toBe("/login?redirect=%2Fdevice&error=invalid_code");
  });

  test("a callback without a state goes back to the sign-in page", async () => {
    const response = await app.request(`${production}/api/auth/callback/github?code=abc`, {}, env);
    expect(response.headers.get("location")).toBe("/login?error=state_not_found");
  });

  test("an old /api/auth/error link goes to the sign-in page", async () => {
    const response = await app.request(`${production}/api/auth/error?error=invalid_code`, {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?error=invalid_code");
  });

  test("a rate-limited exchange is retried once, then reported as github_busy", async () => {
    const { state, cookie } = await startSignIn({});
    let calls = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href === "https://github.com/login/oauth/access_token") {
        calls++;
        return new Response("Access to this site has been restricted.", { status: 429 });
      }
      return realFetch(input, init);
    });
    // Waits out the real two-second pause before the retry.
    const response = await callback(state, cookie);
    expect(calls).toBe(2);
    expect(response.headers.get("location")).toBe("/login?error=github_busy");
  });

  test("a sign-in that GitHub lets through on the retry succeeds", async () => {
    const { state, cookie } = await startSignIn({});
    let calls = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href === "https://github.com/login/oauth/access_token") {
        calls++;
        if (calls === 1) return new Response("restricted", { status: 429 });
        return Response.json({
          access_token: "gho_test",
          token_type: "bearer",
          scope: "user:email",
        });
      }
      if (url.href === "https://api.github.com/user") {
        return Response.json({
          id: 4243,
          login: "busy",
          name: "Busy Cat",
          email: "busy@example.com",
        });
      }
      if (url.href === "https://api.github.com/user/emails") {
        return Response.json([{ email: "busy@example.com", primary: true, verified: true }]);
      }
      return realFetch(input, init);
    });
    // Waits out the real two-second pause before the retry.
    const response = await callback(state, cookie);
    expect(calls).toBe(2);
    expect(response.headers.get("location")).toBe("/runners");
  });
});
