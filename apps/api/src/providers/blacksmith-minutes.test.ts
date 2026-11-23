import { beforeAll, describe, expect, test } from "vitest";
import { blacksmithMinutes } from "./blacksmith-minutes.ts";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";

let env: Env;
beforeAll(async () => {
  env = await testing.createTestEnv();
});

const now = new Date("2026-11-20T19:00:00Z").getTime();
const hour = 3_600_000;

async function workspace() {
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(
    env,
    cookie,
    "Acme",
    `acme-${crypto.randomUUID().slice(0, 8)}`,
  );
  return workspace.id;
}

async function connect(workspaceId: string, fields: Record<string, unknown> = {}) {
  await createDb(env.DB)
    .insert(schema.providerConnection)
    .values({
      workspaceId,
      provider: "blacksmith",
      token: "v1.sealed",
      tokenHint: "cret",
      options: { organization: "acme" },
      accountName: "acme",
      lastSyncedAt: new Date(now - hour),
      ...fields,
    });
}

const day = (iso: string, quantity: number, unit = "billable_minutes") => ({
  provider: "blacksmith",
  day: new Date(iso),
  unit,
  quantity,
  syncedAt: new Date(now),
});

describe("blacksmithMinutes", () => {
  test("without a connection, the minutes can't be counted", async () => {
    const id = await workspace();
    expect(await blacksmithMinutes(createDb(env.DB), id, now)).toMatchObject({
      status: "not_available",
      reason: "not_connected",
      quotaMinutes: 3000,
    });
  });

  test("before the first sync, or with a rejected token, they can't either", async () => {
    const first = await workspace();
    await connect(first, { lastSyncedAt: null });
    expect(await blacksmithMinutes(createDb(env.DB), first, now)).toMatchObject({
      status: "not_available",
      reason: "not_synced",
    });
    const rejected = await workspace();
    await connect(rejected, { failure: "token_rejected" });
    expect(await blacksmithMinutes(createDb(env.DB), rejected, now)).toMatchObject({
      status: "not_available",
      reason: "token_rejected",
    });
  });

  test("this month's billable minutes over two vCPUs, and the recent burn", async () => {
    const id = await workspace();
    await connect(id);
    const db = createDb(env.DB);
    await db.insert(schema.providerDailyUsage).values([
      // Last month, and runtime minutes, don't count.
      { workspaceId: id, ...day("2026-10-31T00:00:00Z", 9000) },
      { workspaceId: id, ...day("2026-11-01T00:00:00Z", 1000) },
      { workspaceId: id, ...day("2026-11-20T00:00:00Z", 3900) },
      { workspaceId: id, ...day("2026-11-20T00:00:00Z", 999, "runtime_minutes") },
    ]);
    // 720 billable minutes in the 6 hours before the sync, and one older job.
    await db.insert(schema.providerJobUsage).values(
      [
        { finishedAt: now - 2 * hour, seconds: 600 * 60 },
        { finishedAt: now - 3 * hour, seconds: 120 * 60 },
        { finishedAt: now - 12 * hour, seconds: 5000 * 60 },
      ].map(({ finishedAt, seconds }, i) => ({
        workspaceId: id,
        provider: "blacksmith",
        jobId: String(i),
        finishedAt: new Date(finishedAt),
        billableSeconds: seconds,
        syncedAt: new Date(now),
      })),
    );
    expect(await blacksmithMinutes(db, id, now)).toEqual({
      status: "ok",
      reason: null,
      accountLogin: "acme",
      quotaMinutes: 3000,
      usedMinutes: 2450,
      // 720 / 2 vCPUs over 6 hours.
      burnRatePerHour: 60,
      cycleStart: "2026-11-01T00:00:00.000Z",
      syncedAt: new Date(now - hour).toISOString(),
    });
  });

  test("a failed sync keeps counting what it last read, and says so", async () => {
    const id = await workspace();
    await connect(id, { failure: "error" });
    await createDb(env.DB)
      .insert(schema.providerDailyUsage)
      .values({ workspaceId: id, ...day("2026-11-05T00:00:00Z", 400) });
    expect(await blacksmithMinutes(createDb(env.DB), id, now)).toMatchObject({
      status: "ok",
      reason: "sync_failed",
      usedMinutes: 200,
    });
  });
});

describe("GET /providers/blacksmith/minutes", () => {
  test("any member reads the workspace's count", async () => {
    const { cookie } = await testing.signIn(env);
    const { cookie: active } = await testing.createWorkspace(
      env,
      cookie,
      "Acme",
      `acme-${crypto.randomUUID().slice(0, 8)}`,
    );
    const response = await testing.call(env, "/providers/blacksmith/minutes", active);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "not_available",
      reason: "not_connected",
      quotaMinutes: 3000,
    });
  });
});

describe("GET /providers/spend", () => {
  test("a workspace with no priced jobs this month has spent nothing", async () => {
    const { cookie } = await testing.signIn(env);
    const { cookie: active } = await testing.createWorkspace(
      env,
      cookie,
      "Acme",
      `acme-${crypto.randomUUID().slice(0, 8)}`,
    );
    const response = await testing.call(env, "/providers/spend", active);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ spend: {} });
  });
});
