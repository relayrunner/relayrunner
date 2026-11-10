import type { ActivityPage } from "@relayrunner/activity";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { deviceColumns, verifyMachineToken } from "./machines.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

// MachineLink is a Durable Object, which the platform proxy can't run here; its own logic is
// tested in durable-objects/machine-session.test.ts. Each machine id gets a stub.
const links = new Map<string, ReturnType<typeof fakeLink>>();
function fakeLink() {
  return {
    status: vi.fn(async () => ({ online: false, state: null, connectedAt: null })),
    revoke: vi.fn(async () => {}),
    notifyPaused: vi.fn(async (_paused: boolean, _by: string | null) => {}),
    fetch: vi.fn(async (_request: Request) => new Response("upgraded")),
  };
}
function link(machineId: string) {
  if (!links.has(machineId)) links.set(machineId, fakeLink());
  return links.get(machineId)!;
}

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
  env.MACHINE_LINK = { getByName: link } as unknown as Env["MACHINE_LINK"];
}, 60_000);

beforeEach(() => links.clear());

afterAll(async () => {
  await proxy?.dispose();
});

const call = (path: string, cookie: string, body?: unknown) =>
  testing.call(env, path, cookie, body);

// What `relayrunner connect` does first.
async function requestCode(clientId = "relayrunner-cli") {
  const response = await app.request(
    "/api/auth/device/code",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
    },
    env,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      error?: string;
    },
  };
}

async function pollToken(deviceCode: string) {
  const response = await app.request(
    "/api/auth/device/token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: "relayrunner-cli",
      }),
    },
    env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

function claim(accessToken: string, body: unknown) {
  return app.request(
    "/api/machines/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function owner(slug: string) {
  const { cookie } = await testing.signIn(env);
  return testing.createWorkspace(env, cookie, slug, slug);
}

// Runs the whole flow and returns the machine token the CLI would keep.
async function enroll(slug: string, name = "atticus-mbp") {
  const { workspace, cookie } = await owner(slug);
  return enrollAs(cookie, workspace.id, name);
}

// The same flow for a user already in the workspace, in whatever role.
async function enrollAs(cookie: string, workspaceId: string, name: string) {
  const { body: code } = await requestCode();
  const approved = await call("/machines/approve", cookie, {
    userCode: code.user_code,
    workspaceId,
    name,
  });
  expect(approved.status).toBe(200);
  const { body: token } = await pollToken(code.device_code);
  const claimed = await claim(token.access_token, {
    deviceCode: code.device_code,
    os: "macos",
    arch: "arm64",
  });
  expect(claimed.status).toBe(200);
  const body = (await claimed.json()) as {
    machine: { id: string; name: string; os: string };
    workspace: { id: string };
    token: string;
  };
  return { ...body, cookie, workspaceId, accessToken: token.access_token, code };
}

describe("machine enrollment", () => {
  test("device codes are only issued to the relayrunner CLI", async () => {
    const { status, body } = await requestCode("someone-else");
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_client");
  });

  test("the verification link points at the dashboard's /device page", async () => {
    const { body } = await requestCode();
    expect(body.verification_uri_complete).toBe(
      `http://localhost:8787/device?user_code=${body.user_code}`,
    );
  });

  test("the CLI waits until the code is approved", async () => {
    const { body } = await requestCode();
    const { status, body: error } = await pollToken(body.device_code);
    expect(status).toBe(400);
    expect(error.error).toBe("authorization_pending");
  });

  test("approve, poll and claim yields a machine token for the chosen workspace", async () => {
    const { machine, workspace, token, workspaceId, accessToken } = await enroll("enroll-ok");
    expect(token).toMatch(/^rrm_[\w-]{43}$/);
    expect(workspace.id).toBe(workspaceId);
    expect(machine).toMatchObject({ name: "atticus-mbp", os: "macos" });

    const db = createDb(env.DB);
    expect(await verifyMachineToken(db, token)).toMatchObject({ id: machine.id, workspaceId });
    expect(await verifyMachineToken(db, "rrm_nope")).toBeNull();
    expect(await verifyMachineToken(db, accessToken)).toBeNull();

    // Only the hash is stored.
    const row = await env.DB.prepare("select token_hash, enrollment_hash from machine where id = ?")
      .bind(machine.id)
      .first<{ token_hash: string; enrollment_hash: string | null }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.enrollment_hash).toBeNull();
  });

  test("the device-flow user session is revoked by the claim", async () => {
    const { accessToken, code } = await enroll("enroll-session");
    const me = await app.request(
      "/api/me",
      { headers: { authorization: `Bearer ${accessToken}` } },
      env,
    );
    expect(me.status).toBe(401);
    // And the same code can't claim twice (the session is gone, and so is the enrollment).
    const again = await claim(accessToken, {
      deviceCode: code.device_code,
      os: "macos",
      arch: "arm64",
    });
    expect(again.status).toBe(401);
  });

  test("a user can't approve into a workspace they aren't in", async () => {
    const { workspace } = await owner("enroll-theirs");
    const { cookie } = await testing.signIn(env);
    const { body: code } = await requestCode();
    const response = await call("/machines/approve", cookie, {
      userCode: code.user_code,
      workspaceId: workspace.id,
      name: "intruder",
    });
    expect(response.status).toBe(403);
  });

  test("looking at a code doesn't claim it, so another account can still approve it", async () => {
    const viewer = await owner("enroll-viewer");
    const approver = await owner("enroll-approver");
    const { body: code } = await requestCode();
    const looked = await call(`/machines/device?user_code=${code.user_code}`, viewer.cookie);
    expect(looked.status).toBe(200);
    expect(await looked.json()).toEqual({ user_code: code.user_code, status: "pending" });
    const response = await call("/machines/approve", approver.cookie, {
      userCode: code.user_code,
      workspaceId: approver.workspace.id,
      name: "approved",
    });
    expect(response.status).toBe(200);
    expect((await call(`/machines/device?user_code=${code.user_code}`, viewer.cookie)).status).toBe(
      200,
    );
  });

  test("looking up a code that doesn't exist is an invalid request", async () => {
    const { cookie } = await owner("enroll-missing");
    const response = await call("/machines/device?user_code=NOPENOPE", cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  test("a code another user claimed can't be approved", async () => {
    const first = await owner("enroll-first");
    const second = await owner("enroll-second");
    const { body: code } = await requestCode();
    expect((await call(`/auth/device?user_code=${code.user_code}`, first.cookie)).status).toBe(200);
    const response = await call("/machines/approve", second.cookie, {
      userCode: code.user_code,
      workspaceId: second.workspace.id,
      name: "stolen",
    });
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare("select count(*) as n from machine where name = 'stolen'").first(),
    ).toEqual({ n: 0 });
  });

  test("an approved code can't be approved again", async () => {
    const { workspace, cookie } = await owner("enroll-twice");
    const { body: code } = await requestCode();
    const body = { userCode: code.user_code, workspaceId: workspace.id, name: "once" };
    expect((await call("/machines/approve", cookie, body)).status).toBe(200);
    expect((await call("/machines/approve", cookie, body)).status).toBe(409);
  });

  test("the user code is accepted with its dash and in lowercase", async () => {
    const { workspace, cookie } = await owner("enroll-dash");
    const { body: code } = await requestCode();
    const userCode = `${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`.toLowerCase();
    const response = await call("/machines/approve", cookie, {
      userCode,
      workspaceId: workspace.id,
      name: "dashed",
    });
    expect(response.status).toBe(200);
  });

  test("claim checks the body and the device code", async () => {
    const { workspace, cookie } = await owner("enroll-claim");
    const { body: code } = await requestCode();
    await call("/machines/approve", cookie, {
      userCode: code.user_code,
      workspaceId: workspace.id,
      name: "box",
    });
    const { body: token } = await pollToken(code.device_code);
    expect(
      (await claim(token.access_token, { deviceCode: code.device_code, os: "beos", arch: "x64" }))
        .status,
    ).toBe(400);
    expect(
      (await claim(token.access_token, { deviceCode: "wrong", os: "linux", arch: "x64" })).status,
    ).toBe(404);
  });

  test("a denied code ends the CLI's polling", async () => {
    const { cookie } = await owner("enroll-deny");
    const { body: code } = await requestCode();
    // Denying claims the code itself; the page never opened it.
    expect((await call("/machines/deny", cookie, { userCode: code.user_code })).status).toBe(200);
    const { body } = await pollToken(code.device_code);
    expect(body.error).toBe("access_denied");
  });
});

describe("machines in the dashboard", () => {
  test("lists the active workspace's enrolled machines", async () => {
    const { cookie, machine } = await enroll("list-ok", "build-box");
    // An approved but unclaimed code doesn't show up.
    const { body: code } = await requestCode();
    const { workspace } = (await (await call("/workspaces/current", cookie)).json()) as {
      workspace: { id: string };
    };
    await call("/machines/approve", cookie, {
      userCode: code.user_code,
      workspaceId: workspace.id,
      name: "never-claimed",
    });

    const response = await call("/machines", cookie);
    expect(response.status).toBe(200);
    const { machines } = (await response.json()) as { machines: Record<string, unknown>[] };
    expect(machines).toEqual([
      expect.objectContaining({
        id: machine.id,
        name: "build-box",
        os: "macos",
        arch: "arm64",
        // The same labels routing matches on.
        labels: ["self-hosted", "macOS", "ARM64"],
        status: { online: false, state: null, connectedAt: null },
      }),
    ]);
    expect(machines[0]).not.toHaveProperty("tokenHash");
    // Its CLI hasn't reported a device yet.
    expect(machines[0].device).toBeNull();
  });

  test("shows the device its CLI reported on hello", async () => {
    const { cookie, machine } = await enroll("device-ok", "atticus-mbp");
    const reportedAt = new Date("2026-11-06T17:00:00.000Z");
    await createDb(env.DB)
      .update(schema.machine)
      .set(
        deviceColumns(
          {
            kind: "laptop",
            model: "MacBook Pro",
            modelId: "Mac15,9",
            chip: "Apple M3 Pro",
            cpuCores: 12,
            memoryMb: 36864,
            osVersion: "macOS 15.1",
          },
          reportedAt,
        ),
      )
      .where(eq(schema.machine.id, machine.id));
    const { machines } = (await (await call("/machines", cookie)).json()) as {
      machines: { device: unknown }[];
    };
    expect(machines[0].device).toEqual({
      kind: "laptop",
      model: "MacBook Pro",
      modelId: "Mac15,9",
      chip: "Apple M3 Pro",
      cpuCores: 12,
      memoryMb: 36864,
      osVersion: "macOS 15.1",
      reportedAt: reportedAt.toISOString(),
    });
  });

  test("revoking a machine kills its token and hides it", async () => {
    const { cookie, machine, token } = await enroll("revoke-ok");
    const response = await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(response.status).toBe(200);
    expect(await verifyMachineToken(createDb(env.DB), token)).toBeNull();
    // Its live socket is closed too.
    expect(link(machine.id).revoke).toHaveBeenCalledOnce();
    const { machines } = (await (await call("/machines", cookie)).json()) as {
      machines: unknown[];
    };
    expect(machines).toEqual([]);
  });

  test("enrolling and revoking a machine are logged in Activity, with who did it", async () => {
    const { cookie, machine } = await enroll("revoke-log", "studio");
    const revoked = await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(revoked.status).toBe(200);
    const { items } = (await (await call("/activity", cookie)).json()) as ActivityPage;
    expect(items).toMatchObject([
      { type: "machine.revoked", machine: { id: machine.id, name: "studio" }, actor: {} },
      {
        type: "machine.enrolled",
        data: { machineName: "studio", os: "macos", arch: "arm64" },
        actor: {},
      },
    ]);
    expect(items[0].actor).toEqual(items[1].actor);
    expect(items[0].actor).not.toBeNull();
  });

  test("another workspace can't revoke the machine", async () => {
    const { machine, token } = await enroll("revoke-mine");
    const other = await owner("revoke-other");
    const response = await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie: other.cookie } },
      env,
    );
    expect(response.status).toBe(404);
    expect(await verifyMachineToken(createDb(env.DB), token)).not.toBeNull();
    expect(link(machine.id).revoke).not.toHaveBeenCalled();
  });

  test("the list carries each machine's live status", async () => {
    const { cookie, machine } = await enroll("list-live");
    link(machine.id).status.mockResolvedValue({
      online: true,
      state: "busy",
      connectedAt: 1,
    } as never);
    const { machines } = (await (await call("/machines", cookie)).json()) as {
      machines: { status: unknown }[];
    };
    expect(machines[0]?.status).toEqual({ online: true, state: "busy", connectedAt: 1 });
  });
});

describe("machines and roles (#134)", () => {
  const revoke = (id: string, cookie: string) =>
    app.request(
      `/api/machines/${id}`,
      { method: "DELETE", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
  const list = async (cookie: string) =>
    (
      (await (await call("/machines", cookie)).json()) as {
        machines: { id: string; canRevoke: boolean }[];
      }
    ).machines;

  test("a member enrolls a machine and revokes it", async () => {
    const { workspace } = await owner("roles-member-own");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const { machine, token } = await enrollAs(member.cookie, workspace.id, "member-mbp");
    expect(await list(member.cookie)).toEqual([
      expect.objectContaining({ id: machine.id, canRevoke: true }),
    ]);
    expect((await revoke(machine.id, member.cookie)).status).toBe(200);
    expect(await verifyMachineToken(createDb(env.DB), token)).toBeNull();
  });

  test("a member can't revoke someone else's machine", async () => {
    const { machine, token, workspaceId } = await enroll("roles-member-other");
    const member = await testing.joinWorkspace(env, workspaceId, "member");
    expect(await list(member.cookie)).toEqual([
      expect.objectContaining({ id: machine.id, canRevoke: false }),
    ]);
    const response = await revoke(machine.id, member.cookie);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await verifyMachineToken(createDb(env.DB), token)).not.toBeNull();
    expect(link(machine.id).revoke).not.toHaveBeenCalled();
  });

  test("an admin can revoke a member's machine", async () => {
    const { workspace, cookie } = await owner("roles-admin");
    const admin = await testing.joinWorkspace(env, workspace.id, "admin");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const { machine } = await enrollAs(member.cookie, workspace.id, "member-mini");
    expect(await list(cookie)).toEqual([
      expect.objectContaining({ id: machine.id, canRevoke: true }),
    ]);
    expect((await revoke(machine.id, admin.cookie)).status).toBe(200);
  });

  test("a member revoking a machine that isn't there gets not found", async () => {
    const { workspace } = await owner("roles-missing");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    expect((await revoke("nope", member.cookie)).status).toBe(404);
  });
});

describe("removing a member (#138)", () => {
  const removeMember = (cookie: string, workspaceId: string, memberIdOrEmail: string) =>
    call("/auth/organization/remove-member", cookie, {
      organizationId: workspaceId,
      memberIdOrEmail,
    });
  const live = async (token: string) =>
    (await verifyMachineToken(createDb(env.DB), token)) !== null;

  test("revokes every machine they enrolled there, and only theirs", async () => {
    const { workspace, cookie } = await owner("remove-member");
    const ownerMachine = await enrollAs(cookie, workspace.id, "owner-mbp");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const laptop = await enrollAs(member.cookie, workspace.id, "zach-mbp");
    const studio = await enrollAs(member.cookie, workspace.id, "zach-studio");
    const stays = await testing.joinWorkspace(env, workspace.id, "member");
    const staysMachine = await enrollAs(stays.cookie, workspace.id, "other-mbp");

    const removed = await removeMember(cookie, workspace.id, member.user.email);
    expect(removed.status).toBe(200);

    expect(await live(laptop.token)).toBe(false);
    expect(await live(studio.token)).toBe(false);
    expect(link(laptop.machine.id).revoke).toHaveBeenCalledOnce();
    expect(link(studio.machine.id).revoke).toHaveBeenCalledOnce();
    expect(await live(ownerMachine.token)).toBe(true);
    expect(await live(staysMachine.token)).toBe(true);
    expect(link(ownerMachine.machine.id).revoke).not.toHaveBeenCalled();
    expect(link(staysMachine.machine.id).revoke).not.toHaveBeenCalled();

    const { items } = (await (await call("/activity", cookie)).json()) as ActivityPage;
    const [first, second, third] = items;
    expect([first, second].map((item) => item.machine?.name).sort()).toEqual([
      "zach-mbp",
      "zach-studio",
    ]);
    expect(first).toMatchObject({ type: "machine.revoked" });
    expect(second).toMatchObject({ type: "machine.revoked" });
    expect(third).toMatchObject({
      type: "member.removed",
      data: { memberName: member.user.name, left: false },
      machine: null,
    });
    // The owner did all three.
    expect(third.actor).not.toBeNull();
    expect(third.actor?.id).not.toBe(member.user.id);
    expect(first.actor).toEqual(third.actor);
  });

  test("leaving revokes their machines too, with them as the actor", async () => {
    const { workspace, cookie } = await owner("leave-member");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const laptop = await enrollAs(member.cookie, workspace.id, "leaver-mbp");

    const left = await call("/auth/organization/leave", member.cookie, {
      organizationId: workspace.id,
    });
    expect(left.status).toBe(200);

    expect(await live(laptop.token)).toBe(false);
    expect(link(laptop.machine.id).revoke).toHaveBeenCalledOnce();
    const { items } = (await (await call("/activity", cookie)).json()) as ActivityPage;
    expect(items.slice(0, 2)).toMatchObject([
      { type: "machine.revoked", actor: { id: member.user.id } },
      { type: "member.removed", data: { left: true }, actor: { id: member.user.id } },
    ]);
  });

  test("leaves their machines in other workspaces alone", async () => {
    const { workspace, cookie } = await owner("remove-elsewhere");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const here = await enrollAs(member.cookie, workspace.id, "here-mbp");
    const own = await testing.createWorkspace(env, member.cookie, "own", "remove-elsewhere-own");
    const elsewhere = await enrollAs(own.cookie, own.workspace.id, "elsewhere-mbp");

    expect((await removeMember(cookie, workspace.id, member.user.email)).status).toBe(200);
    expect(await live(here.token)).toBe(false);
    expect(await live(elsewhere.token)).toBe(true);
    expect(link(elsewhere.machine.id).revoke).not.toHaveBeenCalled();
  });

  test("a removal Better Auth refuses revokes nothing", async () => {
    const { workspace } = await owner("remove-refused");
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const laptop = await enrollAs(member.cookie, workspace.id, "refused-mbp");
    const other = await testing.joinWorkspace(env, workspace.id, "member");

    // Members can't remove each other.
    const refused = await removeMember(other.cookie, workspace.id, member.user.email);
    expect(refused.ok).toBe(false);
    expect(await live(laptop.token)).toBe(true);
    expect(link(laptop.machine.id).revoke).not.toHaveBeenCalled();
  });
});

describe("the machine WebSocket", () => {
  const connect = (headers: Record<string, string>) =>
    app.request("/api/machines/connect", { headers }, env);

  test("needs a WebSocket upgrade", async () => {
    const { token } = await enroll("ws-upgrade");
    expect((await connect({ authorization: `Bearer ${token}` })).status).toBe(426);
  });

  test("rejects a missing, unknown or revoked token before upgrading", async () => {
    const { token, machine, cookie } = await enroll("ws-auth");
    const upgrade = { upgrade: "websocket" };
    expect((await connect(upgrade)).status).toBe(401);
    expect((await connect({ ...upgrade, authorization: "Bearer rrm_nope" })).status).toBe(401);
    // A user session isn't a machine token.
    expect((await connect({ ...upgrade, cookie })).status).toBe(401);

    await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect((await connect({ ...upgrade, authorization: `Bearer ${token}` })).status).toBe(401);
    // The CLI's check after a failed upgrade: a plain GET, which Cloudflare passes through.
    expect((await connect({ authorization: `Bearer ${token}` })).status).toBe(401);
    expect(link(machine.id).fetch).not.toHaveBeenCalled();
  });

  test("hands the socket to the machine's MachineLink, without the token", async () => {
    const { token, machine } = await enroll("ws-ok");
    const response = await connect({ upgrade: "websocket", authorization: `Bearer ${token}` });
    expect(await response.text()).toBe("upgraded");
    const forwarded = link(machine.id).fetch.mock.calls[0]![0];
    expect(forwarded.headers.get("x-relayrunner-machine-id")).toBe(machine.id);
    expect(forwarded.headers.get("authorization")).toBeNull();
  });
});

describe("sharing a machine (#242)", () => {
  const share = (id: string, cookie: string, sharing: unknown) =>
    app.request(
      `/api/machines/${id}/sharing`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", origin: env.BETTER_AUTH_URL },
        body: JSON.stringify({ sharing }),
      },
      env,
    );
  type SharedMachine = { machine: { sharing: string } };

  test("a new machine runs only its owner's jobs", async () => {
    const { cookie, machine } = await enroll("share-default");
    const { machines } = (await (await call("/machines", cookie)).json()) as {
      machines: { id: string; sharing: string }[];
    };
    expect(machines).toEqual([expect.objectContaining({ id: machine.id, sharing: "only_me" })]);
  });

  test("the owner shares it with anyone and back, each change logged once", async () => {
    const { cookie, machine } = await enroll("share-owner", "studio");
    const shared = await share(machine.id, cookie, "anyone");
    expect(shared.status).toBe(200);
    expect(((await shared.json()) as SharedMachine).machine.sharing).toBe("anyone");
    // Setting what's already the case logs nothing.
    expect((await share(machine.id, cookie, "anyone")).status).toBe(200);
    expect((await share(machine.id, cookie, "only_me")).status).toBe(200);

    const { items } = (await (await call("/activity", cookie)).json()) as ActivityPage;
    const changes = items.filter((item) => item.type === "machine.sharing_changed");
    expect(changes).toMatchObject([
      { data: { machineName: "studio", sharing: "only_me" }, actor: {} },
      { data: { machineName: "studio", sharing: "anyone" }, actor: {} },
    ]);
    expect(changes[0].actor).not.toBeNull();
  });

  test("only the owner can change it, not an admin or a member", async () => {
    const { machine, workspaceId, cookie } = await enroll("share-others");
    const admin = await testing.joinWorkspace(env, workspaceId, "admin");
    const member = await testing.joinWorkspace(env, workspaceId, "member");
    for (const other of [admin, member]) {
      const response = await share(machine.id, other.cookie, "anyone");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "not_owner" });
    }
    expect((await share(machine.id, cookie, "anyone")).status).toBe(200);
  });

  test("the list says whose machine it is, for the card's owner row (#243)", async () => {
    const { machine, workspaceId, cookie } = await enroll("share-owner-row");
    const member = await testing.joinWorkspace(env, workspaceId, "member");
    type Listed = { machines: { id: string; owner: string; ownerImage: unknown; mine: boolean }[] };
    const mine = (await (await call("/machines", cookie)).json()) as Listed;
    expect(mine.machines).toEqual([
      expect.objectContaining({ id: machine.id, owner: expect.any(String), mine: true }),
    ]);
    expect(mine.machines[0]).toHaveProperty("ownerImage");
    const theirs = (await (await call("/machines", member.cookie)).json()) as Listed;
    expect(theirs.machines).toEqual([expect.objectContaining({ id: machine.id, mine: false })]);
  });

  test("another workspace gets not found, and a bad value is rejected", async () => {
    const { machine, cookie } = await enroll("share-mine");
    const other = await owner("share-other");
    expect((await share(machine.id, other.cookie, "anyone")).status).toBe(404);
    expect((await share(machine.id, cookie, "people")).status).toBe(400);
  });
});

describe("sharing from the machine's own CLI (#244)", () => {
  const fromCli = (token: string, sharing: unknown) =>
    app.request(
      "/api/machines/me/sharing",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ sharing }),
      },
      env,
    );
  const me = async (token: string) =>
    (await (
      await app.request("/api/machines/me", { headers: { authorization: `Bearer ${token}` } }, env)
    ).json()) as { machine: { sharing: string }; workspace: { memberCount: number } };

  test("claim reports the workspace's member count, for the connect prompt", async () => {
    const { workspace } = await enroll("cli-share-count");
    expect(workspace).toMatchObject({ memberCount: 1 });
    const { workspaceId } = await enroll("cli-share-count-2");
    const member = await testing.joinWorkspace(env, workspaceId, "member");
    const second = await enrollAs(member.cookie, workspaceId, "teammate-mbp");
    expect(second.workspace).toMatchObject({ memberCount: 2 });
  });

  test("the token changes sharing, logged as the machine's owner", async () => {
    const { token, cookie } = await enroll("cli-share", "studio");
    expect((await me(token)).machine.sharing).toBe("only_me");
    const response = await fromCli(token, "anyone");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { machine: { sharing: string } }).machine.sharing).toBe(
      "anyone",
    );
    expect((await me(token)).machine.sharing).toBe("anyone");

    const { items } = (await (await call("/activity", cookie)).json()) as ActivityPage;
    const [change] = items.filter((item) => item.type === "machine.sharing_changed");
    expect(change).toMatchObject({ data: { machineName: "studio", sharing: "anyone" } });
    expect(change.actor).not.toBeNull();
  });

  test("needs a valid machine token and a known value", async () => {
    const { token, cookie } = await enroll("cli-share-auth");
    expect((await fromCli("rrm_nope", "anyone")).status).toBe(401);
    const asUser = await app.request(
      "/api/machines/me/sharing",
      {
        method: "PUT",
        headers: { cookie, origin: env.BETTER_AUTH_URL, "content-type": "application/json" },
        body: JSON.stringify({ sharing: "anyone" }),
      },
      env,
    );
    expect(asUser.status).toBe(401);
    expect((await fromCli(token, "team")).status).toBe(400);
  });
});

describe("pausing a machine", () => {
  const fromCli = (token: string, action: "pause" | "resume") =>
    app.request(
      `/api/machines/me/${action}`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      env,
    );

  test("pausing from the dashboard keeps the machine listed, marked paused by its user", async () => {
    const { cookie, machine, token } = await enroll("pause-ok", "studio");
    const response = await call(`/machines/${machine.id}/pause`, cookie, {});
    expect(response.status).toBe(200);
    const { machine: paused } = (await response.json()) as {
      machine: { paused: { at: string; by: string | null } | null };
    };
    expect(paused.paused).toEqual({ at: expect.any(String), by: expect.any(String) });
    // Still enrolled: the token works and the machine is listed.
    expect(await verifyMachineToken(createDb(env.DB), token)).not.toBeNull();
    const { machines } = (await (await call("/machines", cookie)).json()) as {
      machines: { id: string; paused: unknown }[];
    };
    expect(machines).toEqual([expect.objectContaining({ id: machine.id, paused: paused.paused })]);
    // Its open connection hears about it, with who did it.
    expect(link(machine.id).notifyPaused).toHaveBeenCalledWith(true, paused.paused!.by);
  });

  test("resume clears it, and both are logged in Activity once", async () => {
    const { cookie, machine } = await enroll("pause-log", "studio");
    await call(`/machines/${machine.id}/pause`, cookie, {});
    // Pausing a paused machine changes nothing and logs nothing.
    await call(`/machines/${machine.id}/pause`, cookie, {});
    const resumed = await call(`/machines/${machine.id}/resume`, cookie, {});
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { machine: { paused: unknown } }).machine.paused).toBeNull();
    expect(link(machine.id).notifyPaused.mock.calls).toEqual([
      [true, expect.any(String)],
      [false, null],
    ]);

    const { items } = (await (await call("/activity", cookie)).json()) as ActivityPage;
    expect(items.slice(0, 2)).toMatchObject([
      { type: "machine.resumed", data: { machineName: "studio", via: "dashboard" }, actor: {} },
      { type: "machine.paused", data: { machineName: "studio", via: "dashboard" }, actor: {} },
    ]);
    expect(items[0].actor).not.toBeNull();
    expect(items.filter((item) => item.type === "machine.paused")).toHaveLength(1);
  });

  test("the machine's own CLI can pause and resume it, logged without a user", async () => {
    const { cookie, machine, token } = await enroll("pause-cli");
    const paused = await fromCli(token, "pause");
    expect(paused.status).toBe(200);
    expect(
      ((await paused.json()) as { machine: { paused: { by: string | null } } }).machine.paused.by,
    ).toBeNull();
    expect(link(machine.id).notifyPaused).toHaveBeenCalledWith(true, null);
    expect((await fromCli(token, "resume")).status).toBe(200);

    const { items } = (await (await call("/activity", cookie)).json()) as ActivityPage;
    expect(items.slice(0, 2)).toMatchObject([
      { type: "machine.resumed", data: { via: "cli" }, actor: null },
      { type: "machine.paused", data: { via: "cli" }, actor: null },
    ]);
  });

  test("the CLI needs a valid machine token", async () => {
    const { cookie } = await enroll("pause-cli-auth");
    expect((await fromCli("rrm_nope", "pause")).status).toBe(401);
    const asUser = await app.request(
      "/api/machines/me/pause",
      { method: "POST", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(asUser.status).toBe(401);
  });

  test("any member can pause and resume someone else's machine", async () => {
    const { machine, workspaceId } = await enroll("pause-member");
    const member = await testing.joinWorkspace(env, workspaceId, "member");
    expect((await call(`/machines/${machine.id}/pause`, member.cookie, {})).status).toBe(200);
    expect((await call(`/machines/${machine.id}/resume`, member.cookie, {})).status).toBe(200);
  });

  test("another workspace can't pause the machine", async () => {
    const { machine } = await enroll("pause-mine");
    const other = await owner("pause-other");
    const response = await call(`/machines/${machine.id}/pause`, other.cookie, {});
    expect(response.status).toBe(404);
    expect(link(machine.id).notifyPaused).not.toHaveBeenCalled();
  });

  test("whoami shows that the machine is paused", async () => {
    const { token } = await enroll("pause-me");
    await fromCli(token, "pause");
    const response = await app.request(
      "/api/machines/me",
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await response.json()) as { machine: { paused: unknown } };
    expect(body.machine.paused).toEqual({ at: expect.any(String), by: null });
  });
});

describe("a machine looking itself up", () => {
  const me = (headers: Record<string, string> = {}) =>
    app.request("/api/machines/me", { headers }, env);

  test("returns the machine, its workspace, who enrolled it and its live status", async () => {
    const { token, machine, workspaceId } = await enroll("me-ok", "build-box");
    link(machine.id).status.mockResolvedValue({
      online: true,
      state: "idle",
      connectedAt: 5,
    } as never);
    const response = await me({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, Record<string, unknown>>;
    expect(body.machine).toMatchObject({
      id: machine.id,
      name: "build-box",
      os: "macos",
      arch: "arm64",
      revokedAt: null,
      status: { online: true, state: "idle", connectedAt: 5 },
    });
    expect(body.machine).not.toHaveProperty("tokenHash");
    expect(body.workspace).toEqual({
      id: workspaceId,
      name: "me-ok",
      slug: "me-ok",
      memberCount: 1,
    });
    expect(body.enrolledBy).toMatchObject({ name: expect.any(String), email: expect.any(String) });
  });

  test("rejects a missing, unknown, user or revoked token", async () => {
    const { token, machine, cookie } = await enroll("me-auth");
    expect((await me()).status).toBe(401);
    expect((await me({ authorization: "Bearer rrm_nope" })).status).toBe(401);
    expect((await me({ cookie })).status).toBe(401);

    await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect((await me({ authorization: `Bearer ${token}` })).status).toBe(401);
  });
});
