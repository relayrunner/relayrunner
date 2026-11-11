import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { recordEvent } from "./activity.ts";
import { app } from "./app.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";
import { accessEnv, accessJwt } from "./testing-access.ts";

const uninstalled = vi.hoisted(() => [] as number[]);
vi.mock("./github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.ts")>()),
  deleteInstallation: async (_env: unknown, installationId: number) => {
    uninstalled.push(installationId);
  },
}));

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;
const purgedMachines: string[] = [];
const purgedRouters: string[] = [];

beforeAll(async () => {
  const started = await testing.startD1();
  proxy = started.proxy;
  env = {
    ...started.env,
    ...accessEnv,
    // Durable Objects don't run in the platform proxy.
    MACHINE_LINK: {
      getByName: (id: string) => ({ purge: async () => void purgedMachines.push(id) }),
    } as unknown as Env["MACHINE_LINK"],
    ROUTER: {
      getByName: (id: string) => ({ purge: async () => void purgedRouters.push(id) }),
    } as unknown as Env["ROUTER"],
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function del(path: string, cookie: string, body?: unknown) {
  const headers = new Headers({ cookie, "Cf-Access-Jwt-Assertion": await accessJwt() });
  if (body) headers.set("content-type", "application/json");
  return app.request(
    `/api/admin${path}`,
    { method: "DELETE", headers, body: body ? JSON.stringify(body) : undefined },
    env,
  );
}

async function operator() {
  const signedIn = await testing.signIn(env);
  await env.DB.prepare("update user set role = 'operator' where id = ?")
    .bind(signedIn.user.id)
    .run();
  return signedIn;
}

let seq = 0;

// A signed-up test user with a workspace holding everything onboarding and a few jobs create.
async function onboardedUser() {
  seq += 1;
  const signedIn = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(
    env,
    signedIn.cookie,
    `Test ${seq}`,
    `test-${seq}`,
  );
  const db = createDb(env.DB);
  const installationId = 7000 + seq;
  const machineId = `delete-machine-${seq}`;
  const jobId = 990_000 + seq;
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: `tester-${seq}`,
    accountType: "User",
  });
  await testing.useInstallation(env, workspace.id, installationId);
  await db.insert(schema.githubRepository).values({
    id: installationId,
    installationId,
    fullName: `tester-${seq}/app`,
    private: true,
    githubStateAt: new Date(),
  });
  await db.insert(schema.machine).values({
    id: machineId,
    workspaceId: workspace.id,
    name: "laptop",
    createdBy: signedIn.user.id,
  });
  await db.insert(schema.workflowJob).values({
    id: jobId,
    installationId,
    repositoryId: installationId,
    repositoryFullName: `tester-${seq}/app`,
    runId: jobId,
    runAttempt: 1,
    kind: "job",
    name: "test",
    labels: ["ubuntu-latest"],
    headSha: "abc",
    status: "completed",
    conclusion: "success",
    machineId,
    githubCreatedAt: new Date(),
  });
  await recordEvent(db, { workspaceId: workspace.id, jobId, type: "job.routed", data: {} });
  return { ...signedIn, workspace, installationId, machineId };
}

// Rows anywhere in D1 that still point at what was deleted.
async function leftovers(ids: { userId?: string; workspaceId: string; installationId: number }) {
  const one = async (sql: string, value: string | number) =>
    (await env.DB.prepare(sql).bind(value).first<{ n: number }>())!.n;
  const counts: Record<string, number> = {
    workspace: await one("select count(*) n from workspace where id = ?", ids.workspaceId),
    members: await one(
      "select count(*) n from workspace_member where workspace_id = ?",
      ids.workspaceId,
    ),
    machines: await one("select count(*) n from machine where workspace_id = ?", ids.workspaceId),
    activity: await one(
      "select count(*) n from activity_event where workspace_id = ?",
      ids.workspaceId,
    ),
    activeSessions: await one(
      "select count(*) n from session where active_workspace_id = ?",
      ids.workspaceId,
    ),
    installation: await one(
      "select count(*) n from github_installation where id = ?",
      ids.installationId,
    ),
    repos: await one(
      "select count(*) n from github_repository where installation_id = ?",
      ids.installationId,
    ),
    jobs: await one(
      "select count(*) n from workflow_job where installation_id = ?",
      ids.installationId,
    ),
  };
  if (ids.userId) {
    counts.user = await one("select count(*) n from user where id = ?", ids.userId);
    counts.sessions = await one("select count(*) n from session where user_id = ?", ids.userId);
    counts.accounts = await one("select count(*) n from account where user_id = ?", ids.userId);
  }
  return counts;
}

const none = (counts: Record<string, number>) =>
  Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));

describe("operator deletes", () => {
  test("deleting a workspace and uninstalling the App leaves nothing behind", async () => {
    const op = await operator();
    const tester = await onboardedUser();
    const res = await del(`/workspaces/${tester.workspace.id}`, op.cookie, {
      uninstallGitHubApp: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: {
        id: tester.workspace.id,
        name: `Test ${seq}`,
        machines: 1,
        uninstalled: [`tester-${seq}`],
        forgotten: [],
      },
    });
    expect(uninstalled).toContain(tester.installationId);
    expect(purgedMachines).toContain(tester.machineId);
    expect(purgedRouters).toContain(tester.workspace.id);
    const counts = await leftovers({
      workspaceId: tester.workspace.id,
      installationId: tester.installationId,
    });
    expect(counts).toEqual(none(counts));
  });

  test("without uninstalling, the install is forgotten until GitHub mentions it again", async () => {
    const op = await operator();
    const tester = await onboardedUser();
    const res = await del(`/workspaces/${tester.workspace.id}`, op.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspace: { uninstalled: [], forgotten: [`tester-${seq}`] },
    });
    expect(uninstalled).not.toContain(tester.installationId);
    const counts = await leftovers({
      workspaceId: tester.workspace.id,
      installationId: tester.installationId,
    });
    expect(counts).toEqual(none(counts));
    expect((await del(`/workspaces/${tester.workspace.id}`, op.cookie)).status).toBe(404);
  });

  test("deleting a user takes their own workspaces and sign-in with them", async () => {
    const op = await operator();
    const tester = await onboardedUser();
    const res = await del(`/users/${tester.user.id}`, op.cookie, { uninstallGitHubApp: true });
    expect(res.status).toBe(200);
    const counts = await leftovers({
      userId: tester.user.id,
      workspaceId: tester.workspace.id,
      installationId: tester.installationId,
    });
    expect(counts).toEqual(none(counts));
    // Their old cookie no longer signs in.
    expect((await testing.call(env, "/workspaces/current", tester.cookie)).status).toBe(401);
  });

  test("refuses a user who shares a workspace, and changes nothing", async () => {
    const op = await operator();
    const tester = await onboardedUser();
    const teammate = await testing.joinWorkspace(env, tester.workspace.id, "member");
    const res = await del(`/users/${teammate.user.id}`, op.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "shared_workspaces",
      workspaces: [{ id: tester.workspace.id, name: `Test ${seq}` }],
    });
    const row = await env.DB.prepare("select count(*) n from user where id = ?")
      .bind(teammate.user.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  test("needs an operator, and never deletes the caller", async () => {
    const op = await operator();
    const regular = await testing.signIn(env);
    expect((await del(`/users/${op.user.id}`, regular.cookie)).status).toBe(403);
    expect((await del(`/users/${op.user.id}`, op.cookie)).status).toBe(400);
    expect((await del("/users/missing", op.cookie)).status).toBe(404);
    expect(
      (await del("/workspaces/missing", op.cookie, { uninstallGitHubApp: "yes" })).status,
    ).toBe(400);
  });
});
