import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import { logAuth } from "./auth/auth.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { createTestEnv } from "./testing.ts";

const production = "https://app.relayrunner.dev";

let env: Env;

beforeAll(async () => {
  env = await createTestEnv({ env: { BETTER_AUTH_URL: production } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A RateLimit binding that allows `allowed` calls per key and records the keys it saw.
function fakeLimiter(allowed: number) {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    async limit({ key }: { key: string }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= allowed };
    },
  };
}

function post(path: string, limiter: ReturnType<typeof fakeLimiter>, ip = "203.0.113.7") {
  return app.request(
    `${production}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: production, "cf-connecting-ip": ip },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    },
    { ...env, AUTH_LIMITER: limiter },
  );
}

describe("AUTH_LIMITER", () => {
  test("answers 429 once an IP passes the limit on a sign-in endpoint", async () => {
    const limiter = fakeLimiter(2);
    expect((await post("/api/auth/sign-in/social", limiter)).status).toBe(200);
    expect((await post("/api/auth/sign-in/social", limiter)).status).toBe(200);
    const limited = await post("/api/auth/sign-in/social", limiter);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  test("counts each IP and path on its own", async () => {
    const limiter = fakeLimiter(1);
    expect((await post("/api/auth/sign-in/social", limiter)).status).toBe(200);
    expect((await post("/api/auth/sign-in/social", limiter, "198.51.100.1")).status).toBe(200);
    expect((await post("/api/auth/device/code", limiter)).status).not.toBe(429);
    expect([...limiter.keys.keys()]).toEqual([
      "203.0.113.7:/api/auth/sign-in/social",
      "198.51.100.1:/api/auth/sign-in/social",
      "203.0.113.7:/api/auth/device/code",
    ]);
  });

  test("leaves session reads alone", async () => {
    const limiter = fakeLimiter(0);
    const response = await app.request(
      `${production}/api/auth/get-session`,
      { headers: { "cf-connecting-ip": "203.0.113.7" } },
      { ...env, AUTH_LIMITER: limiter },
    );
    expect(response.status).toBe(200);
    expect(limiter.keys.size).toBe(0);
  });
});

describe("logAuth", () => {
  test("logs Better Auth's errors for features that are off as info", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    logAuth("error", "Email and password is not enabled. Make sure to enable it in the options");
    logAuth("error", "Verification email isn't enabled.");
    logAuth("error", "Provider not found. Make sure to add the provider in your auth config");
    expect(info).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
  });

  test("keeps every other error an error", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    logAuth("error", "State not found");
    expect(error).toHaveBeenCalledWith("auth.log", "State not found", {});
  });
});
