import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  describeAccess,
  groupAllows,
  isHiddenRunner,
  isOwnRunner,
  matchLabels,
  routingLabelFromLabels,
  runnerArch,
  runnerOs,
  runnerStatus,
  type GroupAccess,
} from "./github-runners.ts";
import * as testing from "./testing.ts";

// Installation tokens need the App's private key; the GitHub calls themselves go to the fake below.
vi.mock("./github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));

const access = (overrides: Partial<GroupAccess> = {}): GroupAccess => ({
  groupId: 1,
  groupName: "Default",
  visibility: "all",
  restrictedToWorkflows: false,
  repositoryIds: null,
  ...overrides,
});

describe("github runner helpers", () => {
  test("reads RelayRunner's routing label, ignoring case and route labels", () => {
    expect(routingLabelFromLabels(["self-hosted", "RR-RUNNER-0a1b2c3d"])).toBe(
      "rr-runner-0a1b2c3d",
    );
    expect(routingLabelFromLabels(["rr-0a1b2c3d4e5f"])).toBeNull();
    expect(routingLabelFromLabels(["rr-runner-xyz"])).toBeNull();
  });

  test("knows RelayRunner's own pick and JIT runners", () => {
    expect(isOwnRunner({ labels: ["relayrunner"] })).toBe(true);
    expect(isOwnRunner({ labels: ["rr-0a1b2c3d4e5f"] })).toBe(true);
    expect(isOwnRunner({ labels: ["self-hosted", "macOS", "rr-runner-0a1b2c3d"] })).toBe(false);
  });

  test("hides one-job runners, such as Blacksmith's", () => {
    expect(isHiddenRunner({ ephemeral: true, labels: ["self-hosted"] })).toBe(true);
    expect(isHiddenRunner({ labels: ["blacksmith-2vcpu-ubuntu-2404"] })).toBe(true);
    // As GitHub lists Blacksmith's scale-set runners: no labels, not marked ephemeral.
    expect(
      isHiddenRunner({ name: "blacksmith-2vcpu-ubuntu-2404-abwomh33pubx36hk", labels: [] }),
    ).toBe(true);
    expect(isHiddenRunner({ ephemeral: false, labels: ["self-hosted", "macOS"] })).toBe(false);
  });

  test("maps GitHub's OS name and architecture label", () => {
    expect(runnerOs({ os: "macOS" })).toBe("macos");
    expect(runnerOs({ os: "Plan 9" })).toBeNull();
    expect(runnerArch({ labels: ["self-hosted", "macOS", "ARM64"] })).toBe("arm64");
    expect(runnerArch({ labels: ["self-hosted"] })).toBeNull();
  });

  test("matches jobs on GitHub's labels, not the routing label", () => {
    expect(matchLabels(["self-hosted", "macOS", "rr-runner-0a1b2c3d"])).toEqual([
      "self-hosted",
      "macOS",
    ]);
  });

  test("checks the runner group before a repo's job can go there", () => {
    expect(groupAllows(access(), 7)).toBe(true);
    expect(groupAllows(access({ visibility: "private" }), 7)).toBe(true);
    expect(groupAllows(access({ visibility: "selected", repositoryIds: [7] }), 7)).toBe(true);
    expect(groupAllows(access({ visibility: "selected", repositoryIds: [8] }), 7)).toBe(false);
    expect(groupAllows(access({ restrictedToWorkflows: true }), 7)).toBe(false);
    // Unknown (GitHub didn't answer) doesn't take the runner out.
    expect(groupAllows(null, 7)).toBe(true);
  });

  test("reads an added runner's routing status from GitHub and its group", () => {
    const mini = {
      id: 11,
      name: "mini",
      os: "macOS",
      status: "online" as const,
      busy: false,
      ephemeral: false,
      labels: ["self-hosted", "macOS", "rr-runner-0a1b2c3d"],
    };
    expect(runnerStatus(mini, access(), 7)).toEqual({
      online: true,
      state: "idle",
      labels: ["self-hosted", "macOS"],
    });
    expect(runnerStatus({ ...mini, busy: true }, access(), 7)).toMatchObject({ state: "busy" });
    expect(runnerStatus({ ...mini, status: "offline" }, access(), 7)).toMatchObject({
      online: false,
    });
    // Gone from GitHub, or its group leaves the repo out: never picked.
    expect(runnerStatus(undefined, access(), 7)).toEqual({ online: false, state: null });
    expect(runnerStatus(mini, access({ visibility: "selected", repositoryIds: [8] }), 7)).toEqual({
      online: false,
      state: null,
    });
  });

  test("describes the group's access for the dashboard", () => {
    expect(describeAccess(access())).toBe("Default group · all private repos");
    expect(
      describeAccess(
        access({ groupName: "builders", visibility: "selected", repositoryIds: [1, 2] }),
      ),
    ).toBe("builders group · 2 selected repos");
    expect(describeAccess(access({ restrictedToWorkflows: true }))).toBe(
      "Default group · selected workflows only",
    );
  });
});

describe("adding GitHub runners", () => {
  let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
  let env: Env;

  beforeAll(async () => {
    ({ proxy, env } = await testing.startD1());
    env.MACHINE_LINK = {
      getByName: () => ({
        status: async () => ({ online: false, state: null, connectedAt: null }),
        revoke: async () => {},
      }),
    } as unknown as Env["MACHINE_LINK"];
  }, 60_000);

  afterAll(async () => {
    await proxy?.dispose();
  });

  // The org's runners and groups as GitHub would answer, and the label calls made.
  let runners: {
    id: number;
    name: string;
    os: string;
    status: string;
    busy: boolean;
    ephemeral: boolean;
    labels: { name: string }[];
  }[];
  let groups: { id: number; name: string; visibility: string; restricted_to_workflows?: boolean }[];
  let labelCalls: { method: string; url: string; body?: unknown }[];
  let githubPaths: string[];

  beforeEach(() => {
    runners = [
      runner(11, "atticus-mac-mini", "macOS", ["self-hosted", "macOS", "ARM64", "xcode-16"]),
      runner(12, "pick-abc", "Linux", ["relayrunner"]),
      runner(13, "zach-mbp-0a1b2c3d4e5f", "macOS", ["rr-0a1b2c3d4e5f"]),
      { ...runner(14, "scale-set", "Linux", ["self-hosted", "Linux"]), ephemeral: true },
      runner(15, "blacksmith-2vcpu-ubuntu-2404-abc", "Linux", ["blacksmith-2vcpu-ubuntu-2404"]),
      runner(16, "blacksmith-2vcpu-ubuntu-2404-def", "Linux", []),
    ];
    groups = [{ id: 1, name: "Default", visibility: "all" }];
    labelCalls = [];
    githubPaths = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
      const path = new URL(url).pathname;
      githubPaths.push(path);
      if (/\/actions\/runners\/\d+\/labels/.test(path)) {
        labelCalls.push({
          method: init?.method ?? "GET",
          url: path,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ labels: [] });
      }
      if (path.endsWith("/actions/runners"))
        return Response.json({ total_count: runners.length, runners });
      if (path.endsWith("/actions/runner-groups"))
        return Response.json({ total_count: groups.length, runner_groups: groups });
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runner(id: number, name: string, os: string, labels: string[]) {
    return {
      id,
      name,
      os,
      status: "online",
      busy: false,
      ephemeral: false,
      labels: labels.map((name) => ({ name })),
    };
  }

  let installations = 900;

  // An owner with a workspace that has connected one org.
  async function setup() {
    const { cookie } = await testing.signIn(env);
    installations += 1;
    const created = await testing.createWorkspace(
      env,
      cookie,
      "Runners",
      `runners-${installations}`,
    );
    await createDb(env.DB)
      .insert(schema.githubInstallation)
      .values({
        id: installations,
        workspaceId: created.workspace.id,
        accountId: installations,
        accountLogin: `org-${installations}`,
        accountType: "Organization",
      });
    return {
      cookie: created.cookie,
      workspaceId: created.workspace.id,
      installationId: installations,
    };
  }

  test("lists the org's runners, leaving out RelayRunner's own and one-job runners", async () => {
    const { cookie, installationId } = await setup();
    const response = await testing.call(env, "/machines/github-runners", cookie);
    expect(response.status).toBe(200);
    const { orgs } = (await response.json()) as {
      orgs: {
        installationId: number;
        runners: { id: number; access: string; blocked: string | null; machineId: string | null }[];
      }[];
    };
    expect(orgs).toHaveLength(1);
    expect(orgs[0].installationId).toBe(installationId);
    expect(orgs[0].runners.map((r) => r.id)).toEqual([11]);
    expect(orgs[0].runners[0]).toMatchObject({
      access: "Default group · all private repos",
      blocked: null,
      machineId: null,
    });
  });

  test("groups=false reads only the runner list, for the found card", async () => {
    const { cookie } = await setup();
    const response = await testing.call(env, "/machines/github-runners?groups=false", cookie);
    expect(response.status).toBe(200);
    const { orgs } = (await response.json()) as {
      orgs: { runners: { id: number; blocked: string | null }[] }[];
    };
    expect(orgs[0].runners.map((r) => [r.id, r.blocked])).toEqual([[11, null]]);
    expect(githubPaths.filter((path) => path.includes("/actions/"))).toEqual([
      expect.stringMatching(/\/actions\/runners$/),
    ]);
  });

  test("adds a runner: labels it on GitHub and lists it with its live status", async () => {
    const { cookie, installationId } = await setup();
    const added = await testing.call(env, "/machines/github-runners", cookie, {
      installationId,
      runnerIds: [11],
    });
    expect(added.status).toBe(200);
    const body = (await added.json()) as {
      added: {
        id: string;
        name: string;
        source: string;
        routingLabel: string;
        os: string;
        arch: string;
      }[];
    };
    expect(body.added).toHaveLength(1);
    const machine = body.added[0];
    expect(machine).toMatchObject({
      name: "atticus-mac-mini",
      source: "github",
      os: "macos",
      arch: "arm64",
    });
    expect(machine.routingLabel).toMatch(/^rr-runner-[0-9a-f]{8}$/);
    expect(labelCalls).toEqual([
      {
        method: "POST",
        url: `/orgs/org-${installationId}/actions/runners/11/labels`,
        body: { labels: [machine.routingLabel] },
      },
    ]);

    runners[0].busy = true;
    const listed = await testing.call(env, "/machines", cookie);
    const { machines } = (await listed.json()) as {
      machines: {
        id: string;
        labels: string[];
        status: { online: boolean; state: string };
        github?: { access: string; missing: boolean };
      }[];
    };
    const row = machines.find((m) => m.id === machine.id)!;
    expect(row.status).toMatchObject({ online: true, state: "busy" });
    expect(row.labels).toEqual(["self-hosted", "macOS", "ARM64", "xcode-16"]);
    expect(row.github).toMatchObject({
      access: "Default group · all private repos",
      missing: false,
    });

    // A second add of the same runner is skipped, and the list says it's added.
    const again = await testing.call(env, "/machines/github-runners", cookie, {
      installationId,
      runnerIds: [11],
    });
    expect(await again.json()).toMatchObject({
      added: [],
      skipped: [{ runnerId: 11, reason: "already_added" }],
    });
  });

  test("won't add a runner whose group only allows selected workflows", async () => {
    const { cookie, installationId } = await setup();
    groups = [{ id: 1, name: "Default", visibility: "all", restricted_to_workflows: true }];
    const response = await testing.call(env, "/machines/github-runners", cookie, {
      installationId,
      runnerIds: [11],
    });
    expect(await response.json()).toMatchObject({
      added: [],
      skipped: [{ runnerId: 11, reason: "workflows" }],
    });
    expect(labelCalls).toEqual([]);
  });

  test("members can't list or add runners", async () => {
    const { workspaceId, installationId } = await setup();
    const member = await testing.joinWorkspace(env, workspaceId, "member");
    expect((await testing.call(env, "/machines/github-runners", member.cookie)).status).toBe(403);
    const add = await testing.call(env, "/machines/github-runners", member.cookie, {
      installationId,
      runnerIds: [11],
    });
    expect(add.status).toBe(403);
  });

  test("removing a runner takes its label off on GitHub and keeps it out of the list", async () => {
    const { cookie, workspaceId, installationId } = await setup();
    const added = await testing.call(env, "/machines/github-runners", cookie, {
      installationId,
      runnerIds: [11],
    });
    const machine = ((await added.json()) as { added: { id: string; routingLabel: string }[] })
      .added[0];

    // A member can't remove it, though they can see it.
    const member = await testing.joinWorkspace(env, workspaceId, "member");
    const denied = await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie: member.cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(denied.status).toBe(403);

    labelCalls = [];
    const removed = await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(removed.status).toBe(200);
    expect(labelCalls).toEqual([
      {
        method: "DELETE",
        url: `/orgs/org-${installationId}/actions/runners/11/labels/${machine.routingLabel}`,
        body: undefined,
      },
    ]);
    const listed = (await (await testing.call(env, "/machines", cookie)).json()) as {
      machines: { id: string }[];
    };
    expect(listed.machines.some((m) => m.id === machine.id)).toBe(false);
  });

  test("a runner gone from GitHub lists as missing", async () => {
    const { cookie, installationId } = await setup();
    await testing.call(env, "/machines/github-runners", cookie, {
      installationId,
      runnerIds: [11],
    });
    runners = runners.filter((r) => r.id !== 11);
    const { machines } = (await (await testing.call(env, "/machines", cookie)).json()) as {
      machines: { status: { online: boolean }; github?: { missing: boolean } }[];
    };
    expect(machines[0]).toMatchObject({ status: { online: false }, github: { missing: true } });
  });
});
