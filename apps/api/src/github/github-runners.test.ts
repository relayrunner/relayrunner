import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { listRunners, type RunnerScope } from "./github-app.ts";
import {
  describeAccess,
  groupAllows,
  groupBlocksRepo,
  isHiddenRunner,
  isOwnRunner,
  matchLabels,
  routingLabelFromLabels,
  runnerArch,
  runnerOs,
  runnerStatus,
  type GroupAccess,
} from "./github-runners.ts";
import * as testing from "../testing.ts";

// Installation tokens need the App's private key; the GitHub calls themselves go to the fake below.
vi.mock("./github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));

const repo = { id: 7, private: true };
const access = (overrides: Partial<GroupAccess> = {}): GroupAccess => ({
  groupId: 1,
  groupName: "Default",
  visibility: "all",
  restrictedToWorkflows: false,
  allowsPublicRepositories: false,
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
    expect(groupAllows(access(), repo)).toBe(true);
    expect(groupAllows(access({ visibility: "private" }), repo)).toBe(true);
    expect(groupAllows(access({ visibility: "selected", repositoryIds: [7] }), repo)).toBe(true);
    expect(groupAllows(access({ visibility: "selected", repositoryIds: [8] }), repo)).toBe(false);
    expect(groupAllows(access({ restrictedToWorkflows: true }), repo)).toBe(false);
    // Unknown (GitHub didn't answer) doesn't take the runner out.
    expect(groupAllows(null, repo)).toBe(true);
  });

  test("says why a group won't take a repo's jobs", () => {
    const publicRepo = { id: 8, private: false };
    expect(groupBlocksRepo(access(), repo)).toBeNull();
    expect(groupBlocksRepo(access({ visibility: "selected", repositoryIds: [3] }), repo)).toBe(
      "not_selected",
    );
    expect(groupBlocksRepo(access(), publicRepo)).toBe("public");
    expect(groupBlocksRepo(access({ allowsPublicRepositories: true }), publicRepo)).toBeNull();
    expect(
      groupBlocksRepo(
        access({ visibility: "private", allowsPublicRepositories: true }),
        publicRepo,
      ),
    ).toBe("private_only");
    // Workflow limits are left to groupAllows.
    expect(groupBlocksRepo(access({ restrictedToWorkflows: true }), repo)).toBeNull();
    expect(groupAllows(access(), publicRepo)).toBe(false);
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
    expect(runnerStatus(mini, access(), repo)).toEqual({
      online: true,
      state: "idle",
      labels: ["self-hosted", "macOS"],
    });
    expect(runnerStatus({ ...mini, busy: true }, access(), repo)).toMatchObject({ state: "busy" });
    expect(runnerStatus({ ...mini, status: "offline" }, access(), repo)).toMatchObject({
      online: false,
    });
    // Gone from GitHub, or its group leaves the repo out: never picked.
    expect(runnerStatus(undefined, access(), repo)).toEqual({ online: false, state: null });
    expect(
      runnerStatus(mini, access({ visibility: "selected", repositoryIds: [8] }), repo),
    ).toEqual({
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
  let env: Env;

  beforeAll(async () => {
    env = await testing.createTestEnv();
    env.MACHINE_LINK = {
      getByName: () => ({
        status: async () => ({ online: false, state: null, connectedAt: null }),
        revoke: async () => {},
      }),
    } as unknown as Env["MACHINE_LINK"];
    // The Router's cached runner list, read fresh here so each test sees its own runners.
    const githubRunners = async (_installationId: number, scope: RunnerScope) => {
      routerReads += 1;
      const runners = await listRunners("ghs_test", scope).catch(() => null);
      return runners ? { runners, checkedAt: Date.now() } : null;
    };
    env.ROUTER = {
      getByName: () => ({
        githubRunners,
        githubRunnerLists: (
          installationId: number,
          scopes: RunnerScope[],
          options?: { fresh?: boolean },
        ) => {
          freshScans.push(options?.fresh ?? false);
          return Promise.all(
            scopes.map(
              async (scope) => (await githubRunners(installationId, scope))?.runners ?? null,
            ),
          );
        },
      }),
    } as unknown as Env["ROUTER"];
  });

  // The org's runners and groups as GitHub would answer, and the label calls made.
  type Runner = ReturnType<typeof runner>;
  let runners: Runner[];
  // Each repo's own runners, by owner/name. A repo missing here answers 403, as GitHub does
  // without repository Administration.
  let repoRunners: Record<string, Runner[]>;
  let groups: { id: number; name: string; visibility: string; restricted_to_workflows?: boolean }[];
  let labelCalls: { method: string; url: string; body?: unknown }[];
  let githubPaths: string[];
  // Runner lists read through the Router's cache (the fake reads GitHub every time).
  let routerReads = 0;
  // Whether each repo scan asked to skip the Router's cache.
  let freshScans: boolean[] = [];

  beforeEach(() => {
    runners = [
      runner(11, "atticus-mac-mini", "macOS", ["self-hosted", "macOS", "ARM64", "xcode-16"]),
      runner(12, "pick-abc", "Linux", ["relayrunner"]),
      runner(13, "zach-mbp-0a1b2c3d4e5f", "macOS", ["rr-0a1b2c3d4e5f"]),
      { ...runner(14, "scale-set", "Linux", ["self-hosted", "Linux"]), ephemeral: true },
      runner(15, "blacksmith-2vcpu-ubuntu-2404-abc", "Linux", ["blacksmith-2vcpu-ubuntu-2404"]),
      runner(16, "blacksmith-2vcpu-ubuntu-2404-def", "Linux", []),
    ];
    repoRunners = {};
    freshScans = [];
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
      const repo = path.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runners$/)?.[1];
      if (repo) {
        const list = repoRunners[repo];
        return list
          ? Response.json({ total_count: list.length, runners: list })
          : new Response("forbidden", { status: 403 });
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

  // An owner with a workspace that has connected one org (or a personal account).
  async function setup(accountType = "Organization") {
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
        accountId: installations,
        accountLogin: `org-${installations}`,
        accountType,
      });
    await testing.useInstallation(env, created.workspace.id, installations);
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

  test("says when a runner last finished a job, from recent job times", async () => {
    const { cookie, installationId } = await setup();
    const job = (id: number, runnerName: string, hoursAgo: number) => {
      const completedAt = new Date(Date.now() - hoursAgo * 3_600_000);
      return {
        id,
        installationId,
        repositoryId: 1,
        repositoryFullName: "acme/app",
        runId: id,
        runAttempt: 1,
        name: "build",
        labels: ["self-hosted"],
        runnerName,
        startedAt: completedAt,
        completedAt,
      };
    };
    await createDb(env.DB)
      .insert(schema.jobTiming)
      .values([
        job(installationId * 10 + 1, "atticus-mac-mini", 5),
        job(installationId * 10 + 2, "atticus-mac-mini", 2),
        // Too old to count as recent.
        job(installationId * 10 + 3, "atticus-mac-mini", 24 * 30),
      ]);
    const response = await testing.call(env, "/machines/github-runners?groups=false", cookie);
    const { orgs } = (await response.json()) as {
      orgs: { runners: { id: number; lastJobAt: string | null }[] }[];
    };
    const lastJobAt = orgs[0].runners[0].lastJobAt;
    expect(lastJobAt).not.toBeNull();
    expect(Date.now() - Date.parse(lastJobAt!)).toBeLessThan(3 * 3_600_000);
  });

  test("groups=false reads only the runner list, for the found card", async () => {
    const { cookie } = await setup();
    const before = routerReads;
    const response = await testing.call(env, "/machines/github-runners?groups=false", cookie);
    expect(response.status).toBe(200);
    const { orgs } = (await response.json()) as {
      orgs: { runners: { id: number; blocked: string | null }[] }[];
    };
    expect(orgs[0].runners.map((r) => [r.id, r.blocked])).toEqual([[11, null]]);
    expect(githubPaths.filter((path) => path.includes("/actions/"))).toEqual([
      expect.stringMatching(/\/actions\/runners$/),
    ]);
    // Through the Router's short cache, shared with GET /machines.
    expect(routerReads).toBe(before + 1);
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
    expect(row.github).toMatchObject({ missing: false });
    // The list doesn't read runner groups; the card's menu asks for the access line on demand.
    expect(row.github).not.toHaveProperty("access");
    const access = await testing.call(env, `/machines/${machine.id}/access`, cookie);
    expect(await access.json()).toEqual({ access: "Default group · all private repos" });

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
  // Repos the installation sees, as the repository webhooks would have mirrored them.
  async function addRepos(
    installationId: number,
    repos: { id: number; name: string; private: boolean }[],
  ) {
    const now = new Date();
    // In batches: D1 caps the variables in one statement.
    for (let i = 0; i < repos.length; i += 10)
      await createDb(env.DB)
        .insert(schema.githubRepository)
        .values(
          repos.slice(i, i + 10).map((repo) => ({
            id: repo.id,
            installationId,
            fullName: `org-${installationId}/${repo.name}`,
            private: repo.private,
            githubStateAt: now,
          })),
        );
  }

  test("lists runners registered on the org's private repos", async () => {
    const { cookie, installationId } = await setup();
    const id = installationId * 10;
    await addRepos(installationId, [
      { id: id + 1, name: "app", private: true },
      { id: id + 2, name: "site", private: false },
      // GitHub refuses this one (403): left out, the rest still list.
      { id: id + 3, name: "locked", private: true },
    ]);
    repoRunners[`org-${installationId}/app`] = [
      runner(21, "mighty-m1", "macOS", ["self-hosted", "macOS", "ARM64"]),
      runner(22, "pick-def", "Linux", ["relayrunner"]),
    ];
    repoRunners[`org-${installationId}/site`] = [runner(23, "public-box", "Linux", [])];
    const response = await testing.call(env, "/machines/github-runners", cookie);
    const { orgs } = (await response.json()) as {
      orgs: { runners: { id: number; access: string; repo: { fullName: string } | null }[] }[];
    };
    expect(orgs[0].runners.map((r) => [r.id, r.repo?.fullName ?? null, r.access])).toEqual([
      [11, null, "Default group · all private repos"],
      [21, `org-${installationId}/app`, `Repo runner · org-${installationId}/app`],
    ]);
    // Public repos aren't asked: machines never take their jobs.
    expect(githubPaths).not.toContain(`/repos/org-${installationId}/site/actions/runners`);
  });

  test("lists a personal account's repo runners", async () => {
    const { cookie, installationId } = await setup("User");
    await addRepos(installationId, [{ id: installationId * 10, name: "app", private: true }]);
    repoRunners[`org-${installationId}/app`] = [runner(21, "mighty-m1", "macOS", ["self-hosted"])];
    const response = await testing.call(env, "/machines/github-runners", cookie);
    const { orgs } = (await response.json()) as {
      orgs: { personal: boolean; runners: { id: number }[] }[];
    };
    expect(orgs[0]).toMatchObject({ personal: true, runners: [{ id: 21 }] });
    // A personal account has no org runners to ask for.
    expect(githubPaths).not.toContain(`/orgs/org-${installationId}/actions/runners`);
  });

  test("adds a repo runner: labels it on its repo and lists it with its repo", async () => {
    const { cookie, installationId } = await setup();
    const repositoryId = installationId * 10;
    const repo = `org-${installationId}/app`;
    await addRepos(installationId, [{ id: repositoryId, name: "app", private: true }]);
    repoRunners[repo] = [runner(21, "mighty-m1", "macOS", ["self-hosted", "macOS", "ARM64"])];

    const added = await testing.call(env, "/machines/github-runners", cookie, {
      installationId,
      repositoryId,
      runnerIds: [21],
    });
    const machine = ((await added.json()) as { added: { id: string; routingLabel: string }[] })
      .added[0];
    expect(labelCalls).toEqual([
      {
        method: "POST",
        url: `/repos/${repo}/actions/runners/21/labels`,
        body: { labels: [machine.routingLabel] },
      },
    ]);

    repoRunners[repo][0].busy = true;
    const { machines } = (await (await testing.call(env, "/machines", cookie)).json()) as {
      machines: { id: string; status: { state: string }; github: { repo: string | null } }[];
    };
    expect(machines.find((m) => m.id === machine.id)).toMatchObject({
      status: { state: "busy" },
      github: { repo },
    });
    const access = await testing.call(env, `/machines/${machine.id}/access`, cookie);
    expect(await access.json()).toEqual({ access: `Repo runner · ${repo}` });

    labelCalls = [];
    await app.request(
      `/api/machines/${machine.id}`,
      { method: "DELETE", headers: { cookie, origin: env.BETTER_AUTH_URL } },
      env,
    );
    expect(labelCalls).toEqual([
      {
        method: "DELETE",
        url: `/repos/${repo}/actions/runners/21/labels/${machine.routingLabel}`,
        body: undefined,
      },
    ]);
  });

  test("a rescan skips the cached repo scan", async () => {
    const { cookie } = await setup();
    await testing.call(env, "/machines/github-runners", cookie);
    await testing.call(env, "/machines/github-runners?fresh=true", cookie);
    expect(freshScans).toEqual([false, true]);
  });

  test("looks in one repo by name, past the repos it searches on its own", async () => {
    const { cookie, installationId } = await setup();
    const base = installationId * 1000;
    await addRepos(
      installationId,
      Array.from({ length: 101 }, (_, i) => ({
        id: base + i,
        name: `repo-${String(i).padStart(3, "0")}`,
        private: true,
      })),
    );
    repoRunners[`org-${installationId}/repo-100`] = [
      runner(31, "far-mac", "macOS", ["self-hosted"]),
    ];
    type Body = {
      orgs: {
        moreRepos: boolean;
        repoNotFound: boolean;
        runners: { id: number; repo: { fullName: string } | null }[];
      }[];
    };
    const all = (await (
      await testing.call(env, "/machines/github-runners", cookie)
    ).json()) as Body;
    expect(all.orgs[0].moreRepos).toBe(true);
    expect(all.orgs[0].runners.map((r) => r.id)).toEqual([11]);

    const one = (await (
      await testing.call(env, "/machines/github-runners?repo=REPO-100", cookie)
    ).json()) as Body;
    // Only that repo's runners, not the org's.
    expect(one.orgs[0]).toMatchObject({ repoNotFound: false, runners: [{ id: 31 }] });

    const missing = (await (
      await testing.call(env, "/machines/github-runners?repo=nope", cookie)
    ).json()) as Body;
    expect(missing.orgs[0]).toMatchObject({ repoNotFound: true, runners: [] });
  });

  test("won't add a runner from a repo the installation doesn't see", async () => {
    const { cookie, installationId } = await setup();
    const response = await testing.call(env, "/machines/github-runners", cookie, {
      installationId,
      repositoryId: 424242,
      runnerIds: [21],
    });
    expect(response.status).toBe(404);
    expect(labelCalls).toEqual([]);
  });
});
