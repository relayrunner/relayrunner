import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import { BOOKMARK_COOKIE } from "./d1-session.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe("D1 sessions on workspace routes", () => {
  it("hands back a bookmark and reads from it on the next request", async () => {
    const { cookie: signedIn } = await testing.signIn(env);
    const { cookie } = await testing.createWorkspace(env, signedIn, "Acme", "acme-bookmark");

    const first = await testing.call(env, "/activity", cookie);
    expect(first.status).toBe(200);
    const setCookie = first.headers.getSetCookie().find((line) => line.startsWith(BOOKMARK_COOKIE));
    expect(setCookie).toMatch(/HttpOnly/);

    const second = await testing.call(env, "/activity", testing.withSetCookies(cookie, first));
    expect(second.status).toBe(200);
  });
});
