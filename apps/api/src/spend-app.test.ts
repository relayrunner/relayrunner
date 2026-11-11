import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  recordSpendInstallation,
  spendInstallationId,
  syncSpendInstallations,
} from "./spend-app.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;
beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
});
afterAll(() => proxy.dispose());
afterEach(async () => {
  vi.unstubAllGlobals();
  await createDb(env.DB).delete(schema.spendInstallation);
});

const event = (action: string, id: number, accountId: number, receivedAt: string) => ({
  app: "spend" as const,
  event: "installation" as const,
  action,
  deliveryId: `d-${action}-${receivedAt}`,
  installationId: id,
  receivedAt,
  installation: {
    id,
    account: { id: accountId, login: `org-${accountId}`, type: "Organization" },
    repositorySelection: "all" as const,
    suspendedAt: action === "suspend" ? receivedAt : null,
  },
  repositories: [],
});

describe("recordSpendInstallation", () => {
  test("follows installs, suspensions and uninstalls, ignoring older deliveries", async () => {
    const db = createDb(env.DB);
    await recordSpendInstallation(db, event("created", 10, 1, "2026-11-11T10:00:00Z"));
    expect(await spendInstallationId(db, 1)).toBe(10);
    await recordSpendInstallation(db, event("suspend", 10, 1, "2026-11-11T11:00:00Z"));
    expect(await spendInstallationId(db, 1)).toBeNull();
    // A retried `created` from before the suspension doesn't undo it.
    await recordSpendInstallation(db, event("created", 10, 1, "2026-11-11T10:30:00Z"));
    expect(await spendInstallationId(db, 1)).toBeNull();
    await recordSpendInstallation(db, event("unsuspend", 10, 1, "2026-11-11T12:00:00Z"));
    expect(await spendInstallationId(db, 1)).toBe(10);
    await recordSpendInstallation(db, event("deleted", 10, 1, "2026-11-11T13:00:00Z"));
    expect(await spendInstallationId(db, 1)).toBeNull();
  });
});

describe("syncSpendInstallations", () => {
  test("adds installs it didn't hear about and drops ones that are gone", async () => {
    const db = createDb(env.DB);
    await recordSpendInstallation(db, event("created", 20, 2, "2026-11-11T10:00:00Z"));
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/app/installations")
        return Response.json([{ id: 30, account: { id: 3, login: "org-3" }, suspended_at: null }]);
      return new Response("not found", { status: 404 });
    });
    await syncSpendInstallations(
      { ...env, GITHUB_SPEND_APP_PRIVATE_KEY: { get: async () => pem } } as Env,
      new Date("2026-11-11T14:00:00Z"),
    );
    expect(await spendInstallationId(db, 3)).toBe(30);
    expect(await spendInstallationId(db, 2)).toBeNull();
  });
});
