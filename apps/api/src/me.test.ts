import { LEGAL_VERSIONS, legalToAgree } from "@relayrunner/activity";
import { beforeAll, describe, expect, test } from "vitest";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const session = async (cookie: string) =>
  (
    (await (await testing.call(env, "/auth/get-session", cookie)).json()) as {
      user: { termsVersion?: string | null; privacyVersion?: string | null };
    }
  ).user;

describe("POST /api/me/legal", () => {
  test("records the versions agreed to and when, and refreshes the session", async () => {
    const { user, cookie } = await testing.signIn(env);
    // Read once so the session's cookie cache holds the not-yet-agreed user.
    const before = await testing.call(env, "/auth/get-session", cookie);
    const cached = testing.withSetCookies(cookie, before);
    expect(legalToAgree(await session(cached))).toEqual(["terms", "privacy"]);

    const agreed = await testing.call(env, "/me/legal", cached, LEGAL_VERSIONS);
    expect(agreed.status).toBe(200);
    const row = await env.DB.prepare(
      "select terms_version, privacy_version, legal_agreed_at from user where id = ?",
    )
      .bind(user.id)
      .first<{ terms_version: string; privacy_version: string; legal_agreed_at: number }>();
    expect(row).toMatchObject({
      terms_version: LEGAL_VERSIONS.terms,
      privacy_version: LEGAL_VERSIONS.privacy,
    });
    expect(Date.now() - row!.legal_agreed_at).toBeLessThan(10_000);

    expect(legalToAgree(await session(testing.withSetCookies(cached, agreed)))).toEqual([]);
  });

  test("refuses versions other than the current ones", async () => {
    const { cookie } = await testing.signIn(env);
    const old = await testing.call(env, "/me/legal", cookie, {
      ...LEGAL_VERSIONS,
      terms: "2000-01-01",
    });
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ error: "outdated" });
    expect((await testing.call(env, "/me/legal", cookie, {})).status).toBe(400);
    expect(legalToAgree(await session(cookie))).toEqual(["terms", "privacy"]);
  });

  test("needs a signed-in user", async () => {
    expect((await testing.call(env, "/me/legal", "", LEGAL_VERSIONS)).status).toBe(401);
  });
});
