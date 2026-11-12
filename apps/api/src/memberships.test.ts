import { toWebhookMessage } from "@relayrunner/github-webhooks";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import { createAuth } from "./auth.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { GitHubInstallation } from "./github.ts";
import { syncMembershipsFromGitHub } from "./memberships.ts";
import * as testing from "./testing.ts";
import { processWebhook } from "./webhook-queue.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

// What GET /user/installations returns per bearer token. `failing` tokens get that status.
const visibleTo = new Map<string, GitHubInstallation[]>();
const failing = new Map<string, number>();
let reads = 0;

beforeEach(() => {
  visibleTo.clear();
  failing.clear();
  reads = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.github.com/user/installations")) return realFetch(input, init);
    reads += 1;
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    const status = failing.get(token);
    if (status) return Promise.resolve(new Response("{}", { status }));
    const installations = visibleTo.get(token) ?? [];
    return Promise.resolve(Response.json({ total_count: installations.length, installations }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let nextId = 7000;

function installation(overrides: Partial<GitHubInstallation> = {}): GitHubInstallation {
  nextId += 1;
  return {
    id: nextId,
    account: { id: nextId + 5000, login: `team-${nextId}`, type: "Organization" },
    repository_selection: "all",
    suspended_at: null,
    ...overrides,
  };
}

async function webhook(event: string, payload: unknown) {
  const message = toWebhookMessage(event, crypto.randomUUID(), payload);
  expect(message).not.toBeNull();
  await processWebhook(env, message!);
}

const installed = (github: GitHubInstallation, installerId?: number) =>
  webhook("installation", {
    action: "created",
    installation: github,
    ...(installerId === undefined ? {} : { sender: { id: installerId, login: "installer" } }),
  });

const sync = (userId: string, force = true) =>
  syncMembershipsFromGitHub(createAuth(env), createDb(env.DB), userId, { force });

const workspaceOf = async (installationId: number) =>
  (await env.DB.prepare("select id from workspace where installation_id = ?")
    .bind(installationId)
    .first<{ id: string }>())!.id;

const roles = async (userId: string) =>
  (
    await env.DB.prepare(
      "select w.installation_id, m.role from workspace_member m join workspace w on w.id = m.workspace_id where m.user_id = ? order by w.installation_id",
    )
      .bind(userId)
      .all<{ installation_id: number; role: string }>()
  ).results;

const events = async (workspaceId: string) =>
  (
    await env.DB.prepare(
      "select type, data, actor_user_id from activity_event where workspace_id = ? order by id",
    )
      .bind(workspaceId)
      .all<{ type: string; data: string; actor_user_id: string | null }>()
  ).results.map((row) => ({ ...row, data: JSON.parse(row.data) }));

describe("membership from GitHub (#317)", () => {
  test("joins every workspace whose install GitHub shows them, as a member", async () => {
    const { user, githubToken } = await testing.signIn(env);
    const one = installation();
    const two = installation();
    await installed(one);
    await installed(two);
    visibleTo.set(githubToken, [one, two]);

    const result = await sync(user.id);
    expect(result?.joined).toHaveLength(2);
    expect(await roles(user.id)).toEqual([
      { installation_id: one.id, role: "member" },
      { installation_id: two.id, role: "member" },
    ]);
    expect(await events(await workspaceOf(one.id))).toEqual([
      {
        type: "member.joined",
        data: { name: user.name, email: user.email, role: "member" },
        actor_user_id: user.id,
      },
    ]);
  });

  test("whoever installed it, or owns the personal account, joins as owner", async () => {
    const { user, githubId, githubToken } = await testing.signIn(env);
    const org = installation();
    const personal = installation({
      account: { id: githubId, login: `me-${githubId}`, type: "User" },
    });
    const someoneElses = installation();
    await installed(org, githubId);
    await installed(personal);
    await installed(someoneElses, 99);
    visibleTo.set(githubToken, [org, personal, someoneElses]);

    await sync(user.id);
    expect(await roles(user.id)).toEqual([
      { installation_id: org.id, role: "owner" },
      { installation_id: personal.id, role: "owner" },
      { installation_id: someoneElses.id, role: "member" },
    ]);
  });

  test("the install webhook makes an existing user its owner straight away", async () => {
    const { user, githubId, githubToken } = await testing.signIn(env);
    const github = installation();
    await installed(github);
    visibleTo.set(githubToken, [github]);
    await sync(user.id);
    expect(await roles(user.id)).toEqual([{ installation_id: github.id, role: "member" }]);

    // A redelivered `created` that names them as the installer.
    await installed(github, githubId);
    expect(await roles(user.id)).toEqual([{ installation_id: github.id, role: "owner" }]);
  });

  test("an install that drops out of the list removes them, and other roles stay", async () => {
    const { user, githubToken } = await testing.signIn(env);
    const kept = installation();
    const lost = installation();
    await installed(kept);
    await installed(lost);
    visibleTo.set(githubToken, [kept, lost]);
    await sync(user.id);
    await env.DB.prepare("update workspace_member set role = 'admin' where user_id = ?")
      .bind(user.id)
      .run();

    visibleTo.set(githubToken, [kept]);
    const result = await sync(user.id);
    expect(result).toEqual({ joined: [], removed: [await workspaceOf(lost.id)] });
    expect(await roles(user.id)).toEqual([{ installation_id: kept.id, role: "admin" }]);
    expect((await events(await workspaceOf(lost.id))).at(-1)).toEqual({
      type: "member.removed",
      data: { memberName: user.name, left: true },
      actor_user_id: user.id,
    });
  });

  test("an install we never heard of gets its workspace from the user's own list", async () => {
    const { user, githubToken } = await testing.signIn(env);
    const missed = installation();
    visibleTo.set(githubToken, [missed]);

    await sync(user.id);
    const workspace = await env.DB.prepare("select name from workspace where installation_id = ?")
      .bind(missed.id)
      .first();
    expect(workspace).toEqual({ name: missed.account!.login });
    expect(await roles(user.id)).toEqual([{ installation_id: missed.id, role: "member" }]);
  });

  test("GitHub failing changes nothing", async () => {
    const { user, githubToken } = await testing.signIn(env);
    const github = installation();
    await installed(github);
    visibleTo.set(githubToken, [github]);
    await sync(user.id);

    for (const status of [401, 500]) {
      failing.set(githubToken, status);
      expect(await sync(user.id)).toBeNull();
      expect(await roles(user.id)).toEqual([{ installation_id: github.id, role: "member" }]);
    }
  });

  test("listing workspaces syncs, but only every few minutes", async () => {
    const { user, githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    await installed(github);
    visibleTo.set(githubToken, [github]);
    const list = async () => {
      const response = await testing.call(env, "/auth/organization/list", cookie);
      expect(response.status).toBe(200);
      return ((await response.json()) as { id: string }[]).map((workspace) => workspace.id);
    };

    // testing.signIn marks them as just synced.
    expect(await list()).toEqual([]);
    expect(reads).toBe(0);

    await env.DB.prepare("update user set installations_synced_at = ? where id = ?")
      .bind(Date.now() - 10 * 60 * 1000, user.id)
      .run();
    expect(await list()).toEqual([await workspaceOf(github.id)]);
    expect(reads).toBe(1);
    await list();
    expect(reads).toBe(1);
  });

  test("listing workspaces answers from D1 at once and syncs after the response", async () => {
    const { user, githubToken, cookie } = await testing.signIn(env);
    const github = installation();
    await installed(github);
    visibleTo.set(githubToken, [github]);
    await env.DB.prepare("update user set installations_synced_at = ? where id = ?")
      .bind(Date.now() - 10 * 60 * 1000, user.id)
      .run();
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const list = async () => {
      const response = await app.request(
        "/api/auth/organization/list",
        { headers: { cookie } },
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { id: string }[]).map((workspace) => workspace.id);
    };

    // The sync hasn't run yet, so the new install isn't listed...
    expect(await list()).toEqual([]);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(reads).toBe(1);
    // ...and the next load has it.
    expect(await list()).toEqual([await workspaceOf(github.id)]);
  });
});

describe("machine workspaces follow membership (#363)", () => {
  const insertMachine = (id: string, userId: string) =>
    env.DB.prepare(
      "insert into machine (id, user_id, name, os, arch, token_hash, created_at, updated_at) values (?, ?, ?, 'macos', 'arm64', ?, 1, 1)",
    )
      .bind(id, userId, id, `hash-${id}`)
      .run();
  const listed = async (machineId: string) =>
    (
      await env.DB.prepare(
        "select workspace_id from machine_workspace where machine_id = ? order by workspace_id",
      )
        .bind(machineId)
        .all<{ workspace_id: string }>()
    ).results.map((row) => row.workspace_id);

  test("leaving a workspace takes your machines out of it", async () => {
    const { user, githubToken } = await testing.signIn(env);
    const kept = installation();
    const lost = installation();
    await installed(kept);
    await installed(lost);
    visibleTo.set(githubToken, [kept, lost]);
    await sync(user.id);
    const [keptId, lostId] = [await workspaceOf(kept.id), await workspaceOf(lost.id)];
    await insertMachine(`leave-${user.id}`, user.id);
    await env.DB.prepare(
      "insert into machine_workspace (machine_id, workspace_id, created_at) values (?1, ?2, 1), (?1, ?3, 1)",
    )
      .bind(`leave-${user.id}`, keptId, lostId)
      .run();

    visibleTo.set(githubToken, [kept]);
    await sync(user.id);
    expect(await listed(`leave-${user.id}`)).toEqual([keptId]);
  });

  test("a machine in no workspace joins the first one you install, not one you join", async () => {
    const { user, githubId, githubToken } = await testing.signIn(env);
    await insertMachine(`homeless-${user.id}`, user.id);

    const joined = installation();
    await installed(joined, 99);
    visibleTo.set(githubToken, [joined]);
    await sync(user.id);
    expect(await listed(`homeless-${user.id}`)).toEqual([]);

    const mine = installation();
    await installed(mine, githubId);
    visibleTo.set(githubToken, [joined, mine]);
    await sync(user.id);
    const mineId = await workspaceOf(mine.id);
    expect(await listed(`homeless-${user.id}`)).toEqual([mineId]);
    expect((await events(mineId)).map((event) => event.type)).toContain("machine.workspace_added");
  });
});
