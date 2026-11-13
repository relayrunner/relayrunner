import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { listConnections } from "./provider-connections.ts";
import {
  purgeOldProviderUsage,
  saveUsage,
  syncConnection,
  syncProviderConnections,
  syncWindow,
} from "./provider-sync.ts";
import { openToken, sealToken, TokenKeyError } from "./provider-tokens.ts";
import * as testing from "./testing.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const sent: unknown[] = [];
let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv({
    env: {
      PROVIDER_TOKEN_KEY: { get: async () => KEY },
      INSTALLATION_TASKS: {
        sendBatch: async (messages: { body: unknown }[]) => {
          sent.push(...messages.map((m) => m.body));
        },
      } as unknown as Env["INSTALLATION_TASKS"],
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

const fixture = (name: string) =>
  readFileSync(new URL(`./provider-billing/fixtures/${name}`, import.meta.url), "utf8");

const json = (body: string | object, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Answers Depot's API from the fixtures, and refuses any token but `good-token`. */
function stubDepot() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (!url.startsWith("https://api.depot.dev/")) throw new Error(`unexpected ${url}`);
    if (auth !== "Bearer good-token-1234") return json({ code: "unauthenticated" }, 401);
    if (url.endsWith("/ListGithubActionsConnections"))
      return json(fixture("depot-connections.json"));
    const body = JSON.parse(String(init?.body)) as { pageToken?: string };
    return json(fixture(body.pageToken ? "depot-jobs-page-2.json" : "depot-jobs-page-1.json"));
  });
}

async function owner() {
  const { cookie } = await testing.signIn(env);
  return testing.createWorkspace(env, cookie, "Acme", `acme-${crypto.randomUUID().slice(0, 8)}`);
}

const connect = (cookie: string, provider: string, body: unknown) =>
  testing.call(env, `/providers/${provider}/connection`, cookie, body, "PUT");

describe("provider tokens", () => {
  test("seal and open round-trip, and a token can't be opened for another workspace", async () => {
    const sealed = await sealToken(env, "ws_1", "depot", "secret-token");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("secret-token");
    expect(await openToken(env, "ws_1", "depot", sealed)).toBe("secret-token");
    await expect(openToken(env, "ws_2", "depot", sealed)).rejects.toThrow();
    await expect(openToken(env, "ws_1", "warpbuild", sealed)).rejects.toThrow();
  });

  test("without a key, sealing fails with TokenKeyError", async () => {
    await expect(sealToken({}, "ws", "depot", "t")).rejects.toBeInstanceOf(TokenKeyError);
    const short = { PROVIDER_TOKEN_KEY: { get: async () => btoa("too short") } };
    await expect(sealToken(short, "ws", "depot", "t")).rejects.toBeInstanceOf(TokenKeyError);
  });
});

describe("connecting a provider", () => {
  test("lists every connectable provider, not connected, for any member", async () => {
    const { cookie } = await owner();
    const response = await testing.call(env, "/providers/connections", cookie);
    expect(response.status).toBe(200);
    const { connections } = (await response.json()) as { connections: { provider: string }[] };
    expect(connections.map((c) => c.provider)).toEqual(["depot", "namespace", "warpbuild"]);
    expect(connections[1]).toMatchObject({ connected: false, options: { region: "us" } });
  });

  test("an owner saves a token that works: encrypted, hinted, never returned, and synced", async () => {
    stubDepot();
    const { workspace, cookie } = await owner();
    const response = await connect(cookie, "depot", { token: " good-token-1234 " });
    expect(response.status).toBe(200);
    const view = (await response.json()) as Record<string, unknown>;
    expect(view).toMatchObject({
      provider: "depot",
      connected: true,
      tokenHint: "1234",
      accountName: "acme",
      failure: null,
    });
    expect(JSON.stringify(view)).not.toContain("good-token");

    const row = await env.DB.prepare(
      "select token from provider_connection where workspace_id = ? and provider = 'depot'",
    )
      .bind(workspace.id)
      .first<{ token: string }>();
    expect(row!.token).not.toContain("good-token");
    expect(await openToken(env, workspace.id, "depot", row!.token)).toBe("good-token-1234");
    expect(sent).toEqual([{ kind: "provider-sync", workspaceId: workspace.id, provider: "depot" }]);
  });

  test("a token the provider refuses isn't saved", async () => {
    stubDepot();
    const { workspace, cookie } = await owner();
    const response = await connect(cookie, "depot", { token: "wrong-token-0000" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "token_rejected" });
    const row = await env.DB.prepare("select 1 from provider_connection where workspace_id = ?")
      .bind(workspace.id)
      .first();
    expect(row).toBeNull();
  });

  test("an unreachable provider is a 502, and a bad option or provider is refused", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const { cookie } = await owner();
    expect((await connect(cookie, "depot", { token: "good-token-1234" })).status).toBe(502);
    const badRegion = await connect(cookie, "namespace", {
      token: "good-token-1234",
      options: { region: "mars" },
    });
    expect(await badRegion.json()).toEqual({ error: "invalid_options" });
    expect((await connect(cookie, "blacksmith", { token: "good-token-1234" })).status).toBe(404);
    expect((await connect(cookie, "depot", { token: "short" })).status).toBe(400);
  });

  test("without the encryption key, saving says storage isn't available", async () => {
    stubDepot();
    const noKey = { ...env, PROVIDER_TOKEN_KEY: undefined };
    const { cookie } = await owner();
    const response = await testing.call(
      noKey,
      "/providers/depot/connection",
      cookie,
      { token: "good-token-1234" },
      "PUT",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "token_storage_unavailable" });
  });

  test("a member can look but not connect, test or remove", async () => {
    stubDepot();
    const { workspace, cookie } = await owner();
    await connect(cookie, "depot", { token: "good-token-1234" });
    const { cookie: member } = await testing.joinWorkspace(env, workspace.id, "member");
    expect((await testing.call(env, "/providers/connections", member)).status).toBe(200);
    expect((await connect(member, "depot", { token: "good-token-1234" })).status).toBe(403);
    expect((await testing.call(env, "/providers/depot/connection/test", member, {})).status).toBe(
      403,
    );
    expect(
      (await testing.call(env, "/providers/depot/connection", member, {}, "DELETE")).status,
    ).toBe(403);
  });

  test("testing a saved token reports whether it still works", async () => {
    stubDepot();
    const { cookie } = await owner();
    await connect(cookie, "depot", { token: "good-token-1234" });
    const ok = await testing.call(env, "/providers/depot/connection/test", cookie, {});
    expect(await ok.json()).toMatchObject({ ok: true, connection: { accountName: "acme" } });

    // The token was revoked at Depot since.
    vi.stubGlobal("fetch", async () => json({ code: "unauthenticated" }, 401));
    const revoked = await testing.call(env, "/providers/depot/connection/test", cookie, {});
    expect(await revoked.json()).toMatchObject({
      ok: false,
      error: "token_rejected",
      connection: { failure: "token_rejected" },
    });
    const notConnected = await testing.call(
      env,
      "/providers/warpbuild/connection/test",
      cookie,
      {},
    );
    expect(notConnected.status).toBe(404);
  });

  test("removing a connection forgets the token and what it synced", async () => {
    stubDepot();
    const { workspace, cookie } = await owner();
    await connect(cookie, "depot", { token: "good-token-1234" });
    await syncConnection(env, workspace.id, "depot");
    const removed = await testing.call(env, "/providers/depot/connection", cookie, {}, "DELETE");
    expect(await removed.json()).toMatchObject({ connected: false, recent: { jobs: 0 } });
    for (const table of ["provider_connection", "provider_job_usage"]) {
      const row = await env.DB.prepare(`select 1 from ${table} where workspace_id = ?`)
        .bind(workspace.id)
        .first();
      expect(row).toBeNull();
    }
  });
});

describe("syncing", () => {
  test("a first sync reads 30 days; later ones start 7 hours before the last ended", () => {
    const now = new Date("2026-11-13T00:00:00Z");
    expect(syncWindow(null, now).start).toEqual(new Date("2026-10-14T00:00:00Z"));
    expect(syncWindow(new Date("2026-11-12T23:00:00Z"), now).start).toEqual(
      new Date("2026-11-12T16:00:00Z"),
    );
    // Never further back than providers keep.
    expect(syncWindow(new Date("2026-01-01T00:00:00Z"), now).start).toEqual(
      new Date("2026-08-16T00:00:00Z"),
    );
  });

  test("a sync stores each job once, records where it got to, and the list sums it", async () => {
    stubDepot();
    const { workspace, cookie } = await owner();
    await connect(cookie, "depot", { token: "good-token-1234" });
    const now = new Date();
    await syncConnection(env, workspace.id, "depot", now);
    // Seeing the same jobs again replaces them.
    await syncConnection(env, workspace.id, "depot", now);

    const jobs = await createDb(env.DB)
      .select()
      .from(schema.providerJobUsage)
      .where(eq(schema.providerJobUsage.workspaceId, workspace.id));
    expect(jobs.map((j) => j.jobId).sort()).toEqual(["41000000001", "41000000002"]);

    // The fixture's jobs finished on 2026-11-12: 186 + 38 billable seconds, and Depot gives no cost.
    const connections = await listConnections(
      createDb(env.DB),
      workspace.id,
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(connections.find((c) => c.provider === "depot")).toMatchObject({
      lastSyncedAt: now.toISOString(),
      recent: { jobs: 2, billableMinutes: 4, costUsd: null },
    });
  });

  test("a refused token is recorded on the connection instead of thrown", async () => {
    stubDepot();
    const { workspace, cookie } = await owner();
    await connect(cookie, "depot", { token: "good-token-1234" });
    vi.stubGlobal("fetch", async () => json({ code: "unauthenticated" }, 401));
    await syncConnection(env, workspace.id, "depot");
    const row = await env.DB.prepare(
      "select failure, synced_through from provider_connection where workspace_id = ?",
    )
      .bind(workspace.id)
      .first<{ failure: string; synced_through: number | null }>();
    expect(row).toEqual({ failure: "token_rejected", synced_through: null });
  });

  test("the hourly cron queues every connection but a refused one, and drops usage past 90 days", async () => {
    stubDepot();
    const { workspace, cookie } = await owner();
    await connect(cookie, "depot", { token: "good-token-1234" });
    sent.length = 0;
    const now = new Date("2026-11-13T00:00:00Z");
    const db = createDb(env.DB);
    await saveUsage(
      db,
      workspace.id,
      "warpbuild",
      {
        jobs: [
          {
            jobId: "old",
            runId: null,
            repository: null,
            jobName: null,
            runnerLabel: null,
            startedAt: null,
            finishedAt: new Date("2026-07-01T00:00:00Z"),
            billableSeconds: 60,
            queueSeconds: null,
            costUsd: 0.01,
          },
        ],
        days: [
          { day: new Date("2026-07-01T00:00:00Z"), unit: "jobs", quantity: 1, costUsd: 0.01 },
          { day: new Date("2026-11-12T00:00:00Z"), unit: "jobs", quantity: 2, costUsd: 0.02 },
        ],
      },
      now,
    );
    await syncProviderConnections(env);
    const queued = { kind: "provider-sync", workspaceId: workspace.id, provider: "depot" };
    expect(sent).toContainEqual(queued);

    // Once Depot refuses the token, the cron leaves it alone until someone replaces it.
    await env.DB.prepare(
      "update provider_connection set failure = 'token_rejected' where workspace_id = ?",
    )
      .bind(workspace.id)
      .run();
    sent.length = 0;
    await syncProviderConnections(env);
    expect(sent).not.toContainEqual(queued);

    await purgeOldProviderUsage(db, now);
    const left = await env.DB.prepare(
      "select (select count(*) from provider_job_usage where workspace_id = ?1) as jobs, (select count(*) from provider_daily_usage where workspace_id = ?1) as days",
    )
      .bind(workspace.id)
      .first<{ jobs: number; days: number }>();
    expect(left).toEqual({ jobs: 0, days: 1 });
  });
});
