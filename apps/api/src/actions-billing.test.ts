import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  type AccountUsage,
  accountUsage,
  burnRate,
  cycleStart,
  pollActionsUsage,
  pollInstallation,
} from "./actions-billing.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { type InstallationTask, runInstallationTask } from "./installation-tasks.ts";
import { recordSpendInstallation } from "./spend-app.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-11-08T20:00:00Z");
let ids = 0;

async function connectedOrg(accountType = "Organization", { ownerIsAccount = true } = {}) {
  ids += 1;
  const { cookie: signedIn, user, githubToken } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Billing ${ids}`,
    `billing-${ids}`,
  );
  const installationId = 7000 + ids;
  const org = `billing-org-${ids}`;
  const db = createDb(env.DB);
  // A personal account is owned by the GitHub user who signed in and made the workspace, unless a
  // test wants an owner who isn't here.
  const [ownerAccount] = await db
    .select({ accountId: schema.account.accountId })
    .from(schema.account)
    .where(eq(schema.account.userId, user.id));
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId:
      accountType === "Organization" || !ownerIsAccount
        ? installationId
        : Number(ownerAccount!.accountId),
    accountLogin: org,
    accountType,
  });
  await testing.useInstallation(env, workspace.id, installationId);
  await db.insert(schema.githubRepository).values([
    {
      id: installationId * 10,
      installationId,
      fullName: `${org}/app`,
      private: true,
      githubStateAt: NOW,
    },
    {
      id: installationId * 10 + 1,
      installationId,
      fullName: `${org}/site`,
      private: false,
      githubStateAt: NOW,
    },
  ]);
  return { db, cookie, installationId, org, workspaceId: workspace.id, githubToken };
}

function item(day: string, repositoryName: string, quantity: number, sku = "Actions Linux") {
  const rate = sku === "Actions macOS" ? 0.062 : 0.006;
  const gross = quantity * rate;
  return {
    date: `${day}T05:22:12Z`,
    product: "actions",
    sku,
    quantity,
    unitType: "Minutes",
    pricePerUnit: rate,
    grossAmount: gross,
    discountAmount: gross,
    netAmount: 0,
    organizationName: "org",
    repositoryName,
  };
}

function spendEvent(action: string, accountId: number, login: string, id: number) {
  return {
    app: "spend" as const,
    event: "installation" as const,
    action,
    deliveryId: `d-${action}`,
    installationId: id,
    receivedAt: new Date().toISOString(),
    installation: {
      id,
      account: { id: accountId, login, type: "Organization" },
      repositorySelection: "all" as const,
      suspendedAt: null,
    },
    repositories: [],
  };
}

interface GitHubFake {
  plan?: string;
  usage?: unknown[];
  usageStatus?: number;
  budgets?: unknown[];
}

function fakeGitHub(fake: GitHubFake) {
  const calls: string[] = [];
  const tokens: Record<string, string> = {};
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
    const { pathname, search } = new URL(url);
    calls.push(pathname + search);
    tokens[pathname] = new Headers(init?.headers).get("authorization") ?? "";
    if (pathname.endsWith("/settings/billing/usage")) {
      if (fake.usageStatus) return new Response("Forbidden", { status: fake.usageStatus });
      return Response.json({ usageItems: fake.usage ?? [] });
    }
    const minted = pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (minted) return Response.json({ token: `spend-${minted[1]}` }, { status: 201 });
    if (pathname.endsWith("/settings/billing/budgets"))
      return Response.json({ budgets: fake.budgets ?? [] });
    if (pathname.startsWith("/orgs/") || pathname === "/user")
      return Response.json({ plan: { name: fake.plan ?? "free" } });
    return new Response("not found", { status: 404 });
  });
  return Object.assign(calls, { tokens });
}

const actionsBudget = {
  id: "b1",
  budget_type: "ProductPricing",
  budget_product_sku: "actions",
  budget_scope: "organization",
  budget_amount: 0,
  prevent_further_usage: true,
  budget_alerting: { will_alert: true, alert_recipients: ["atticoos"] },
};

describe("pollInstallation", () => {
  test("stores month totals per repo and SKU, plan and budget, and counts private and unknown repos", async () => {
    const { db, installationId, org } = await connectedOrg();
    const calls = fakeGitHub({
      plan: "free",
      usage: [
        item("2026-11-04", "app", 284),
        item("2026-11-06", "app", 16), // same repo and SKU on another day: one month row
        item("2026-11-04", "site", 500), // public: free, doesn't count
        item("2026-11-05", "unmirrored", 10), // unknown: counts as private
        item("2026-11-05", "app", 5, "Actions macOS"), // 5 macOS minutes use ~51.7 Linux minutes
        item("2026-10-31", "app", 999), // last cycle
        { ...item("2026-11-05", "app", 3), product: "copilot" },
      ],
      budgets: [actionsBudget, { ...actionsBudget, budget_product_sku: "packages" }],
    });
    await pollInstallation(db, "tok", { id: installationId, accountLogin: org }, NOW);

    expect(calls).toContain(`/organizations/${org}/settings/billing/usage?year=2026&month=11`);
    const rows = await db
      .select()
      .from(schema.actionsUsage)
      .where(eq(schema.actionsUsage.installationId, installationId));
    expect(rows).toHaveLength(4);
    expect(
      rows.find((row) => row.repositoryName === "app" && row.sku === "Actions Linux"),
    ).toMatchObject({
      quantity: 300,
      cycleStart: new Date("2026-11-01T00:00:00Z"),
    });

    const usage = (await accountUsage(db, installationId, NOW)) as AccountUsage;
    expect(usage).toMatchObject({
      status: "ok",
      reason: null,
      plan: "free",
      quotaMinutes: 2000,
      usedMinutes: 361.7,
      netAmount: 0,
      budget: { amountUsd: 0, preventFurtherUsage: true },
      cycleStart: "2026-11-01T00:00:00.000Z",
      readAt: NOW.toISOString(),
      burnRatePerHour: null,
    });
  });

  test("replaces the month's rows on each poll and gets a burn rate from consecutive readings", async () => {
    const { db, installationId, org } = await connectedOrg();
    const installation = { id: installationId, accountLogin: org };
    const earlier = new Date(NOW.getTime() - 3_600_000);
    fakeGitHub({ usage: [item("2026-11-08", "app", 100)] });
    await pollInstallation(db, "tok", installation, earlier);
    fakeGitHub({ usage: [item("2026-11-08", "app", 160)] });
    await pollInstallation(db, "tok", installation, NOW);

    const rows = await db
      .select()
      .from(schema.actionsUsage)
      .where(eq(schema.actionsUsage.installationId, installationId));
    expect(rows.map((row) => row.quantity)).toEqual([160]);
    const usage = await accountUsage(db, installationId, NOW);
    expect(usage?.usedMinutes).toBe(160);
    expect(usage?.burnRatePerHour).toBe(60);
  });

  test("billed overage logs one Activity event per cycle", async () => {
    const { db, installationId, org, workspaceId } = await connectedOrg();
    const installation = { id: installationId, accountLogin: org, workspaceId };
    const overage = { ...item("2026-11-08", "app", 100), netAmount: 0.6 };
    const overageEvents = () =>
      db
        .select()
        .from(schema.activityEvent)
        .where(eq(schema.activityEvent.workspaceId, workspaceId));

    fakeGitHub({ usage: [item("2026-11-08", "app", 100)] });
    await pollInstallation(db, "tok", installation, new Date(NOW.getTime() - 1_800_000));
    expect(await overageEvents()).toEqual([]);

    fakeGitHub({ usage: [overage] });
    await pollInstallation(db, "tok", installation, new Date(NOW.getTime() - 900_000));
    await pollInstallation(db, "tok", installation, NOW);
    const events = await overageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "minutes.overage",
      data: {
        account: org,
        installationId,
        cycleStart: "2026-11-01T00:00:00.000Z",
        netAmount: 0.6,
      },
    });

    // A new month can log it again.
    const december = new Date("2026-12-02T00:00:00Z");
    fakeGitHub({ usage: [{ ...overage, date: "2026-12-01T05:00:00Z" }] });
    await pollInstallation(db, "tok", installation, december);
    expect(await overageEvents()).toHaveLength(2);
  });

  test("stores hundreds of repos in one poll", async () => {
    const { db, installationId, org } = await connectedOrg();
    const usage = Array.from({ length: 500 }, (_, i) => item("2026-11-08", `repo-${i}`, 1));
    fakeGitHub({ usage });
    await pollInstallation(db, "tok", { id: installationId, accountLogin: org }, NOW);
    expect((await accountUsage(db, installationId, NOW))?.usedMinutes).toBe(500);
  });

  test("a refused usage read is 'missing_permission' and keeps the last good numbers", async () => {
    const { db, installationId, org } = await connectedOrg();
    const installation = { id: installationId, accountLogin: org };
    fakeGitHub({ usage: [item("2026-11-08", "app", 42)] });
    await pollInstallation(db, "tok", installation, new Date(NOW.getTime() - 900_000));
    fakeGitHub({ usageStatus: 403 });
    await pollInstallation(db, "tok", installation, NOW);

    const usage = await accountUsage(db, installationId, NOW);
    expect(usage).toMatchObject({
      status: "not_available",
      reason: "missing_permission",
      usedMinutes: 42,
    });
  });

  test("enterprise and unknown plans aren't available yet", async () => {
    const enterprise = await connectedOrg();
    fakeGitHub({ plan: "enterprise" });
    await pollInstallation(
      enterprise.db,
      "tok",
      { id: enterprise.installationId, accountLogin: enterprise.org },
      NOW,
    );
    expect(await accountUsage(enterprise.db, enterprise.installationId, NOW)).toMatchObject({
      status: "not_available",
      reason: "enterprise",
      quotaMinutes: null,
    });

    const odd = await connectedOrg();
    fakeGitHub({ plan: "legacy_gold" });
    await pollInstallation(odd.db, "tok", { id: odd.installationId, accountLogin: odd.org }, NOW);
    expect((await accountUsage(odd.db, odd.installationId, NOW))?.reason).toBe("unknown_plan");
  });
});

describe("accountUsage", () => {
  test("unpolled accounts, personal or org, say not read yet", async () => {
    const personal = await connectedOrg("User");
    expect((await accountUsage(personal.db, personal.installationId, NOW))?.reason).toBe(
      "not_read_yet",
    );
    const fresh = await connectedOrg();
    expect((await accountUsage(fresh.db, fresh.installationId, NOW))?.reason).toBe("not_read_yet");
    expect(await accountUsage(fresh.db, 999_999, NOW)).toBeNull();
  });

  test("last month's read counts as not read yet in a new cycle", async () => {
    const { db, installationId, org } = await connectedOrg();
    fakeGitHub({ usage: [item("2026-10-30", "app", 500)] });
    await pollInstallation(
      db,
      "tok",
      { id: installationId, accountLogin: org },
      new Date("2026-10-31T23:50:00Z"),
    );
    const usage = await accountUsage(db, installationId, NOW);
    expect(usage).toMatchObject({ reason: "not_read_yet", usedMinutes: 0 });
  });
});

// The cron queues one read per account; this runs what it queued, as the consumer would.
async function runActionsUsagePoll(target: Env, now: Date) {
  const queued: InstallationTask[] = [];
  const queue = {
    sendBatch: async (messages: { body: InstallationTask }[]) => {
      queued.push(...messages.map((message) => message.body));
    },
  } as unknown as Queue<InstallationTask>;
  await pollActionsUsage({ ...target, INSTALLATION_TASKS: queue }, now);
  expect(queued.every((task) => task.kind === "actions-usage")).toBe(true);
  for (const task of queued) await runInstallationTask(target, task);
}

describe("pollActionsUsage", () => {
  test("reads a personal account with its owner's sign-in token", async () => {
    const { db, installationId, org, githubToken } = await connectedOrg("User");
    const calls = fakeGitHub({
      plan: "pro",
      usage: [item("2026-11-04", "app", 120), item("2026-11-04", "site", 500)],
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runActionsUsagePoll(env, NOW);

    const path = `/users/${org}/settings/billing/usage`;
    expect(calls).toContain(`${path}?year=2026&month=11`);
    expect(calls.tokens[path]).toBe(`Bearer ${githubToken}`);
    expect(calls.tokens["/user"]).toBe(`Bearer ${githubToken}`);
    expect(calls.some((call) => call.includes(`/${org}/settings/billing/budgets`))).toBe(false);
    expect(await accountUsage(db, installationId, NOW)).toMatchObject({
      status: "ok",
      reason: null,
      accountType: "User",
      plan: "pro",
      quotaMinutes: 3000,
      usedMinutes: 120,
      budget: null,
    });
  });

  test("a personal account whose owner isn't in the workspace needs a sign-in", async () => {
    const { db, installationId, org } = await connectedOrg("User", { ownerIsAccount: false });
    const calls = fakeGitHub({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runActionsUsagePoll(env, NOW);
    expect(calls.some((call) => call.startsWith(`/users/${org}/`))).toBe(false);
    expect((await accountUsage(db, installationId, NOW))?.reason).toBe("sign_in_needed");
  });

  test("a personal token without Plan: read is a missing permission", async () => {
    const { db, installationId } = await connectedOrg("User");
    fakeGitHub({ usageStatus: 404 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runActionsUsagePoll(env, NOW);
    expect((await accountUsage(db, installationId, NOW))?.reason).toBe("missing_permission");
  });

  test("reads an org with the Spend App's token when the org installed it", async () => {
    const { db, installationId, org } = await connectedOrg();
    const [installation] = await db
      .select({ accountId: schema.githubInstallation.accountId })
      .from(schema.githubInstallation)
      .where(eq(schema.githubInstallation.id, installationId));
    await recordSpendInstallation(db, spendEvent("created", installation!.accountId, org, 77));
    const calls = fakeGitHub({ usage: [item("2026-11-04", "app", 30)] });
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    await runActionsUsagePoll(
      { ...env, GITHUB_SPEND_APP_PRIVATE_KEY: { get: async () => pem } },
      NOW,
    );
    expect(calls.tokens[`/organizations/${org}/settings/billing/usage`]).toBe("Bearer spend-77");
    expect(await accountUsage(db, installationId, NOW)).toMatchObject({
      status: "ok",
      usedMinutes: 30,
      spendApp: true,
    });

    await recordSpendInstallation(db, spendEvent("deleted", installation!.accountId, org, 77));
    expect((await accountUsage(db, installationId, NOW))?.spendApp).toBe(false);
  });

  test("records a token failure per installation and keeps going", async () => {
    const { db, installationId } = await connectedOrg();
    const broken = {
      ...env,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: { get: async () => Promise.reject(new Error("no key")) },
    } as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runActionsUsagePoll(broken, NOW);
    const [billing] = await db
      .select()
      .from(schema.actionsBilling)
      .where(eq(schema.actionsBilling.installationId, installationId));
    expect(billing).toMatchObject({ failure: "error", error: "no key", readAt: null });
    expect((await accountUsage(db, installationId, NOW))?.reason).toBe("error");
  });
});

describe("GET /api/usage/actions", () => {
  test("lists the workspace's accounts", async () => {
    const { db, cookie, installationId, org } = await connectedOrg();
    const now = new Date();
    fakeGitHub({ usage: [item(now.toISOString().slice(0, 10), "app", 12)] });
    await pollInstallation(db, "tok", { id: installationId, accountLogin: org }, now);
    const res = await testing.call(env, "/usage/actions", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: AccountUsage[] };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ installationId, accountLogin: org, usedMinutes: 12 });
  });
});

describe("helpers", () => {
  test("cycleStart is the UTC month", () => {
    expect(cycleStart(new Date("2026-12-01T00:00:00Z")).toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(cycleStart(new Date("2026-11-30T23:59:59Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  test("burnRate needs two readings at least 10 minutes apart", () => {
    const at = (minutes: number, used: number) => ({
      readAt: new Date(NOW.getTime() + minutes * 60_000),
      usedMinutes: used,
    });
    expect(burnRate([at(0, 10)])).toBeNull();
    expect(burnRate([at(0, 10), at(5, 20)])).toBeNull();
    expect(burnRate([at(0, 10), at(30, 20), at(120, 70)])).toBe(30);
  });
});
