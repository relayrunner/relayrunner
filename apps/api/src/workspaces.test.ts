import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { app } from "./app.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

const signIn = () => testing.signIn(env);
const call = (path: string, cookie: string, body?: unknown) =>
  testing.call(env, path, cookie, body);
const createWorkspace = (cookie: string, name: string, slug: string) =>
  testing.createWorkspace(env, cookie, name, slug);

describe("user role", () => {
  test("the session carries user.role, which is how the dashboard spots operators", async () => {
    const { user, cookie } = await signIn();
    await env.DB.prepare("update user set role = 'operator' where id = ?").bind(user.id).run();
    const response = await call("/auth/get-session", cookie);
    const body = (await response.json()) as { user: { role: string | null } };
    expect(body.user.role).toBe("operator");
  });
});

describe("workspaces", () => {
  test("a signed-out request is rejected", async () => {
    const response = await app.request("/api/workspaces/current", {}, env);
    expect(response.status).toBe(401);
  });

  test("a signed-in user without a workspace gets no_active_workspace", async () => {
    const { cookie } = await signIn();
    const response = await call("/workspaces/current", cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_active_workspace" });
  });

  test("a workspace's owner reads it as active, with its one installation", async () => {
    const { user, cookie } = await signIn();
    const { workspace, cookie: jar } = await createWorkspace(cookie, "Acme", "acme");

    const current = await call("/workspaces/current", jar);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      workspace: expect.objectContaining({
        id: workspace.id,
        name: "Acme",
        slug: "acme",
        installationId: workspace.installationId,
      }),
      role: "owner",
      installations: [expect.objectContaining({ id: workspace.installationId })],
    });

    const row = await env.DB.prepare(
      "select workspace_id, user_id, role from workspace_member where workspace_id = ?",
    )
      .bind(workspace.id)
      .first();
    expect(row).toEqual({ workspace_id: workspace.id, user_id: user.id, role: "owner" });
  });

  test("a workspace lists only its own GitHub installation", async () => {
    const { cookie } = await signIn();
    const { workspace, cookie: jar } = await createWorkspace(cookie, "Globex", "globex");
    await createWorkspace((await signIn()).cookie, "Other", "globex-other");

    const current = await call("/workspaces/current", jar);
    const body = (await current.json()) as { installations: { id: number }[] };
    expect(body.installations.map((installation) => installation.id)).toEqual([
      workspace.installationId,
    ]);
  });

  test("a workspace can have more than one member", async () => {
    const { cookie } = await signIn();
    const {
      workspace: { id },
    } = await createWorkspace(cookie, "Initech", "initech");
    const admin = await testing.joinWorkspace(env, id, "admin");
    const member = await testing.joinWorkspace(env, id, "member");
    const rows = await env.DB.prepare(
      "select user_id, role from workspace_member where workspace_id = ? order by created_at",
    )
      .bind(id)
      .all();
    expect(rows.results).toEqual([
      expect.objectContaining({ role: "owner" }),
      { user_id: admin.user.id, role: "admin" },
      { user_id: member.user.id, role: "member" },
    ]);
    const current = await call("/workspaces/current", member.cookie);
    expect(await current.json()).toMatchObject({ role: "member" });
  });

  test("users can't create a workspace (#316)", async () => {
    const { cookie } = await signIn();
    const response = await call("/auth/organization/create", cookie, {
      name: "Acme again",
      slug: "acme-again",
    });
    expect(response.status).toBe(403);
  });
});

describe("runner order", () => {
  const put = (id: string, cookie: string, body: unknown) =>
    app.request(
      `/api/workspaces/${id}/runner-order`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", origin: env.BETTER_AUTH_URL },
        body: JSON.stringify(body),
      },
      env,
    );

  test("a new workspace reads the default order: machine, then github", async () => {
    const { cookie } = await signIn();
    const { workspace, cookie: jar } = await createWorkspace(cookie, "Order", "order-default");
    const response = await call(`/workspaces/${workspace.id}/runner-order`, jar);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      order: { steps: [{ key: "machine" }, { key: "github" }] },
      isDefault: true,
    });
  });

  test("a member saves an order and reads it back", async () => {
    const { cookie } = await signIn();
    const { workspace, cookie: jar } = await createWorkspace(cookie, "Order", "order-save");
    const order = { steps: [{ key: "github" }, { key: "machine" }] };
    const saved = await put(workspace.id, jar, order);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ order, isDefault: false });

    const read = await call(`/workspaces/${workspace.id}/runner-order`, jar);
    expect(await read.json()).toEqual({ order, isDefault: false });
    const row = await env.DB.prepare("select runner_order from workspace where id = ?")
      .bind(workspace.id)
      .first<{ runner_order: string }>();
    expect(JSON.parse(row!.runner_order)).toEqual(order);
  });

  test("an empty order or a repeated provider is rejected with a reason", async () => {
    const { cookie } = await signIn();
    const { workspace, cookie: jar } = await createWorkspace(cookie, "Order", "order-invalid");

    const empty = await put(workspace.id, jar, { steps: [] });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({
      error: "invalid_runner_order",
      issues: [{ path: ["steps"], message: "Add at least one provider." }],
    });

    const twice = await put(workspace.id, jar, { steps: [{ key: "github" }, { key: "github" }] });
    expect(twice.status).toBe(400);
    expect(await twice.json()).toMatchObject({
      issues: [
        {
          path: ["steps", 1, "key"],
          message: "GitHub-hosted is already in the order without a limit.",
        },
      ],
    });

    const unknown = await put(workspace.id, jar, { steps: [{ key: "buildkite" }] });
    expect(unknown.status).toBe(400);

    const read = await call(`/workspaces/${workspace.id}/runner-order`, jar);
    expect(await read.json()).toMatchObject({ isDefault: true });
  });

  test("someone outside the workspace can't read or change its order", async () => {
    const { cookie } = await signIn();
    const { workspace } = await createWorkspace(cookie, "Order", "order-private");
    const { cookie: outsider } = await signIn();

    const read = await call(`/workspaces/${workspace.id}/runner-order`, outsider);
    expect(read.status).toBe(404);
    const write = await put(workspace.id, outsider, { steps: [{ key: "github" }] });
    expect(write.status).toBe(404);

    const signedOut = await app.request(`/api/workspaces/${workspace.id}/runner-order`, {}, env);
    expect(signedOut.status).toBe(401);
  });
});

describe("roles (#134)", () => {
  const put = (id: string, cookie: string, body: unknown) =>
    app.request(
      `/api/workspaces/${id}/runner-order`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", origin: env.BETTER_AUTH_URL },
        body: JSON.stringify(body),
      },
      env,
    );
  const post = (path: string, cookie: string, body: unknown) => call(path, cookie, body);
  const code = async (response: Response) => ((await response.json()) as { code?: string }).code;

  test("a member reads the runner order but only owners and admins change it", async () => {
    const { cookie } = await signIn();
    const { workspace } = await createWorkspace(cookie, "Roles", "roles-order");
    const admin = await testing.joinWorkspace(env, workspace.id, "admin");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const order = { steps: [{ key: "github" }] };

    expect((await call(`/workspaces/${workspace.id}/runner-order`, member.cookie)).status).toBe(
      200,
    );
    const write = await put(workspace.id, member.cookie, order);
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "forbidden" });

    expect((await put(workspace.id, admin.cookie, order)).status).toBe(200);
  });

  test("the last owner can't leave, be removed, or be demoted", async () => {
    const { cookie } = await signIn();
    const { workspace, cookie: owner } = await createWorkspace(cookie, "Roles", "roles-owner");
    const admin = await testing.joinWorkspace(env, workspace.id, "admin");
    const [ownerRow] = (
      await env.DB.prepare(
        "select id from workspace_member where workspace_id = ? and role = 'owner'",
      )
        .bind(workspace.id)
        .all<{ id: string }>()
    ).results;

    const leave = await post("/auth/organization/leave", owner, { organizationId: workspace.id });
    expect(leave.status).toBe(400);
    expect(await code(leave)).toBe("YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER");

    const demote = await post("/auth/organization/update-member-role", owner, {
      organizationId: workspace.id,
      memberId: ownerRow.id,
      role: "admin",
    });
    expect(demote.status).toBe(400);
    expect(await code(demote)).toBe("YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER");

    const removed = await post("/auth/organization/remove-member", admin.cookie, {
      organizationId: workspace.id,
      memberIdOrEmail: ownerRow.id,
    });
    expect(removed.ok).toBe(false);

    const demotedByAdmin = await post("/auth/organization/update-member-role", admin.cookie, {
      organizationId: workspace.id,
      memberId: ownerRow.id,
      role: "member",
    });
    expect(demotedByAdmin.ok).toBe(false);

    const owners = await env.DB.prepare(
      "select count(*) as n from workspace_member where workspace_id = ? and role = 'owner'",
    )
      .bind(workspace.id)
      .first();
    expect(owners).toEqual({ n: 1 });
  });

  test("a member can't change roles or remove anyone", async () => {
    const { cookie } = await signIn();
    const { workspace } = await createWorkspace(cookie, "Roles", "roles-member");
    const admin = await testing.joinWorkspace(env, workspace.id, "admin");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const [adminRow] = (
      await env.DB.prepare("select id from workspace_member where user_id = ?")
        .bind(admin.user.id)
        .all<{ id: string }>()
    ).results;

    const promote = await post("/auth/organization/update-member-role", member.cookie, {
      organizationId: workspace.id,
      memberId: adminRow.id,
      role: "member",
    });
    expect(await code(promote)).toBe("YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER");
    const remove = await post("/auth/organization/remove-member", member.cookie, {
      organizationId: workspace.id,
      memberIdOrEmail: adminRow.id,
    });
    // Better Auth answers this one with a 401.
    expect(await code(remove)).toBe("YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER");
  });
});

describe("machine counts (#136)", () => {
  test("counts each member's live, claimed machines and nobody else's", async () => {
    const { user, cookie } = await signIn();
    const { workspace, cookie: jar } = await createWorkspace(cookie, "Counts", "counts");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const outsider = await signIn();
    await createWorkspace(outsider.cookie, "Other", "counts-other");

    // Machines belong to users, not workspaces (#318).
    const insert = (id: string, userId: string, extra = "") =>
      env.DB.prepare(
        `insert into machine (id, user_id, name, os, arch, revoked_at, created_at, updated_at)
         values (?, ?, ?, ${extra.includes("pending") ? "null" : "'macos'"}, 'arm64', ${
           extra.includes("revoked") ? "1" : "null"
         }, 1, 1)`,
      )
        .bind(id, userId, id)
        .run();
    await insert("count-a", user.id);
    await insert("count-b", user.id);
    await insert("count-c", member.user.id);
    await insert("count-revoked", member.user.id, "revoked");
    await insert("count-pending", member.user.id, "pending");
    await insert("count-other", outsider.user.id);

    for (const viewer of [jar, member.cookie]) {
      const response = await call("/workspaces/current/machine-counts", viewer);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        counts: { [user.id]: 2, [member.user.id]: 1 },
      });
    }
  });
});
