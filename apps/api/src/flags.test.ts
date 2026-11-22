import { Hono } from "hono";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { FlagKey } from "@relayrunner/api-types";
import type { AppEnv } from "./app.ts";
import type { Env } from "./env.ts";
import { respondError } from "./errors.ts";
import { isFlagOn, requireFlag } from "./flags.ts";
import { d1Session } from "./middleware/d1-session.ts";
import { attachSession, requireUser } from "./middleware/session.ts";
import { requireWorkspace } from "./middleware/workspace.ts";
import * as testing from "./testing.ts";

// FLAG_KEYS starts empty, so these tests use a key of their own.
const BETA = "beta" as FlagKey;

// A stand-in for the Flagship binding: `on` lists the flags that are on, for everyone.
function stubFlags(on: string[] = [], fail = false) {
  return {
    getBooleanValue: vi.fn(async (key: string, fallback: boolean) => {
      if (fail) throw new Error("flagship is down");
      return on.includes(key) ? true : fallback;
    }),
  } as unknown as Flagship & { getBooleanValue: ReturnType<typeof vi.fn> };
}

// A flagged route, behind the same middleware a real one uses.
const flagged = new Hono<AppEnv>()
  .basePath("/api")
  .use("*", attachSession, d1Session)
  .get("/beta", requireUser, requireWorkspace, requireFlag(BETA), async (c) =>
    // A second check reads the value the middleware already evaluated.
    c.json({ again: await isFlagOn(c, BETA) }),
  )
  .onError((error, c) => respondError(c, error));

let env: Env;
let cookie: string;
let workspace: { id: string; slug: string };
let userId: string;

beforeAll(async () => {
  env = await testing.createTestEnv();
  const signedIn = await testing.signIn(env);
  userId = signedIn.user.id;
  const created = await testing.createWorkspace(env, signedIn.cookie, "Acme", "acme");
  workspace = created.workspace;
  cookie = created.cookie;
});

const get = (path: string, flags?: Flagship) =>
  flagged.request(path, { headers: { cookie } }, { ...env, FLAGS: flags });

describe("requireFlag", () => {
  test("answers 404 while the flag is off", async () => {
    const res = await get("/api/beta", stubFlags());
    expect(res.status).toBe(404);
  });

  test("lets the request through once the flag is on, evaluating it once", async () => {
    const flags = stubFlags(["beta"]);
    const res = await get("/api/beta", flags);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ again: true });
    expect(flags.getBooleanValue).toHaveBeenCalledTimes(1);
  });

  test("sends the user and workspace for targeting, and nothing else", async () => {
    const flags = stubFlags(["beta"]);
    await get("/api/beta", flags);
    expect(flags.getBooleanValue).toHaveBeenCalledWith("beta", false, {
      targetingKey: userId,
      userId,
      workspaceId: workspace.id,
      workspaceSlug: "acme",
    });
  });

  test("reads as off without a binding, or when evaluation fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await get("/api/beta")).status).toBe(404);
    expect((await get("/api/beta", stubFlags(["beta"], true))).status).toBe(404);
  });
});

describe("GET /api/flags", () => {
  test("answers every flag in FLAG_KEYS for the signed-in user", async () => {
    const res = await testing.call({ ...env, FLAGS: stubFlags() }, "/flags", cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("needs a signed-in user", async () => {
    const res = await testing.call(env, "/flags", "");
    expect(res.status).toBe(401);
  });
});
