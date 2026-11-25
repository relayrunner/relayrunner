import { beforeAll, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { processWebhook } from "../ingest/webhook-queue.ts";
import * as testing from "../testing.ts";
import { GitHubRefreshError, isExpired, refreshGitHubToken } from "./user-tokens.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const options = { clientId: "Iv1.client", clientSecret: "secret" };

describe("refreshGitHubToken", () => {
  test("returns GitHub's new tokens and sends the refresh token", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        access_token: "ghu_new",
        refresh_token: "ghr_new",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      }),
    );
    const tokens = await refreshGitHubToken(options, fetcher as typeof fetch)("ghr_old");
    expect(tokens).toMatchObject({ accessToken: "ghu_new", refreshToken: "ghr_new" });
    expect(tokens.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const body = new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ghr_old");
    expect(body.get("client_id")).toBe("Iv1.client");
  });

  test("throws GitHub's reason when it refuses the refresh with a 200", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = async () =>
      Response.json({
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      });
    const refresh = refreshGitHubToken(options, fetcher as typeof fetch)("ghr_old");
    await expect(refresh).rejects.toBeInstanceOf(GitHubRefreshError);
    await expect(refresh).rejects.toMatchObject({ reason: "bad_refresh_token" });
  });

  test("throws on an HTTP error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = async () => new Response("nope", { status: 500 });
    await expect(
      refreshGitHubToken(options, fetcher as typeof fetch)("ghr_old"),
    ).rejects.toMatchObject({ reason: "http_500" });
  });
});

describe("isExpired", () => {
  test("is true only past a known expiry", () => {
    const now = Date.parse("2026-11-25T01:16:50Z");
    expect(isExpired(new Date("2026-11-25T01:15:44Z"), now)).toBe(true);
    expect(isExpired("2026-11-25T09:15:44Z", now)).toBe(false);
    expect(isExpired(null, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
  });
});

describe("a revoked authorization", () => {
  test("forgets that person's GitHub tokens and no one else's", async () => {
    const db = createDb(env.DB);
    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.user).values([
      { id: "revoker", name: "Revoker", email: "revoker@example.com", emailVerified: true },
      { id: "keeper", name: "Keeper", email: "keeper@example.com", emailVerified: true },
    ]);
    await db.insert(schema.account).values([
      {
        id: "acct-revoker",
        userId: "revoker",
        providerId: "github",
        accountId: "5001",
        accessToken: "ghu_a",
        refreshToken: "ghr_a",
        accessTokenExpiresAt: expiresAt,
      },
      {
        id: "acct-keeper",
        userId: "keeper",
        providerId: "github",
        accountId: "5002",
        accessToken: "ghu_b",
        refreshToken: "ghr_b",
        accessTokenExpiresAt: expiresAt,
      },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    expect(
      await processWebhook(env, {
        event: "github_app_authorization",
        deliveryId: "d",
        action: "revoked",
        installationId: null,
        receivedAt: new Date().toISOString(),
        senderId: 5001,
      }),
    ).toMatchObject({ handler: "authorization_revoked" });

    const accounts = await db
      .select({
        userId: schema.account.userId,
        accessToken: schema.account.accessToken,
        refreshToken: schema.account.refreshToken,
      })
      .from(schema.account)
      .where(eq(schema.account.providerId, "github"));
    expect(accounts).toEqual(
      expect.arrayContaining([
        { userId: "revoker", accessToken: null, refreshToken: null },
        { userId: "keeper", accessToken: "ghu_b", refreshToken: "ghr_b" },
      ]),
    );
  });
});
