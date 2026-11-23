import { relayInputs } from "@relayrunner/runner-order";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { autoPick, relayJobOf } from "./auto-jobs.ts";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { JobContext } from "./routing.ts";
import * as testing from "../testing.ts";

// Who can push to which repo on GitHub, by repo full name and GitHub user id.
const pushers = new Map<string, Set<number>>();
vi.mock("../github/github-app.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github/github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));
vi.mock("../github/repos-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github/repos-api.ts")>()),
  userCanWriteRepo: async (_token: string, repo: string, userId: number) =>
    pushers.get(repo)?.has(userId) ?? false,
}));

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const context = (inputs: Partial<JobContext> = {}): JobContext => ({
  repo: "acme/app",
  runId: 7,
  runAttempt: 1,
  workflow: "CI",
  workflowPath: ".github/workflows/ci.yml",
  startedBy: null,
  triggeredBy: null,
  ...relayInputs(inputs),
});

test("relayJobOf reads the caller's job from the relay's display name", () => {
  expect(relayJobOf("relay-test / RelayRunner")).toBe("relay-test");
  expect(relayJobOf(null)).toBe("relay");
});

describe("auto jobs", () => {
  test("a pick lists the job, and the Router page sizes it", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace, cookie: jar } = await testing.createWorkspace(env, cookie, "Auto", "auto");
    const db = createDb(env.DB);
    const job = {
      workspaceId: workspace.id,
      repositoryId: 1,
      relayJob: "relay-test",
      private: true,
    };

    // No size set anywhere: 2 vCPU, every provider when the relay names none.
    const first = await autoPick(db, { ...job, context: context() });
    expect(first.size).toBe(2);
    expect(first.inputs.blacksmith).toEqual(["blacksmith-2vcpu-ubuntu-2404"]);
    expect(first.inputs.github).toEqual(["ubuntu-latest"]);
    expect(first.inputs.machine).toEqual(["self-hosted"]);

    const listed = await testing.call(env, `/workspaces/${workspace.id}/auto-jobs`, jar);
    const body = (await listed.json()) as {
      size: number;
      jobs: { id: number; relayJob: string }[];
    };
    expect(body.size).toBe(2);
    expect(body.jobs.map((each) => each.relayJob)).toEqual(["relay-test"]);

    // The workspace default, then the job's own size and first provider.
    const size = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-size`,
      jar,
      { size: 4 },
      "PUT",
    );
    expect(size.status).toBe(200);
    expect((await autoPick(db, { ...job, context: context() })).size).toBe(4);

    const saved = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-jobs/${body.jobs[0].id}`,
      jar,
      { size: 8, first: "blacksmith" },
      "PUT",
    );
    expect(saved.status).toBe(200);
    const sized = await autoPick(db, { ...job, context: context({ blacksmith: ["auto"] }) });
    expect(sized).toEqual({
      size: 8,
      first: "blacksmith",
      inputs: relayInputs({ blacksmith: ["blacksmith-8vcpu-ubuntu-2404"] }),
    });

    // A setting left out stays as it is, and the answer says what it replaced.
    const firstOnly = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-jobs/${body.jobs[0].id}`,
      jar,
      { first: null },
      "PUT",
    );
    expect(await firstOnly.json()).toEqual({
      size: 8,
      first: null,
      previous: { size: 8, first: "blacksmith" },
    });

    const bad = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-size`,
      jar,
      { size: 3 },
      "PUT",
    );
    expect(bad.status).toBe(400);
    const missing = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-jobs/999999`,
      jar,
      { size: 8, first: null },
      "PUT",
    );
    expect(missing.status).toBe(404);
  });
});

describe("auto job settings for members", () => {
  test("follow push access to the job's repo, and nothing workspace-wide", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace, cookie: jar } = await testing.createWorkspace(
      env,
      cookie,
      "Repo access",
      "repo-access",
    );
    const member = await testing.joinWorkspace(env, workspace.id, "member");
    const db = createDb(env.DB);
    const now = new Date();
    await db.insert(schema.githubRepository).values(
      [101, 102].map((id) => ({
        id,
        installationId: workspace.installationId,
        fullName: `acme/repo-${id}`,
        private: true,
        githubStateAt: now,
      })),
    );
    for (const repositoryId of [101, 102]) {
      await autoPick(db, {
        workspaceId: workspace.id,
        repositoryId,
        relayJob: "relay-test",
        private: true,
        context: { ...context(), repo: `acme/repo-${repositoryId}` },
      });
    }
    pushers.set("acme/repo-101", new Set([member.githubId]));

    type Listed = { jobs: { id: number; repository: string; canEdit: boolean }[] };
    const list = async (cookie: string) =>
      (await (
        await testing.call(env, `/workspaces/${workspace.id}/auto-jobs`, cookie)
      ).json()) as Listed;
    const byRepo = (listed: Listed) =>
      Object.fromEntries(listed.jobs.map((job) => [job.repository, job.canEdit]));
    expect(byRepo(await list(member.cookie))).toEqual({
      "acme/repo-101": true,
      "acme/repo-102": false,
    });
    // Owners and admins can change every job, without asking GitHub.
    expect(byRepo(await list(jar))).toEqual({ "acme/repo-101": true, "acme/repo-102": true });

    const { jobs } = await list(member.cookie);
    const set = (repository: string) =>
      testing.call(
        env,
        `/workspaces/${workspace.id}/auto-jobs/${jobs.find((job) => job.repository === repository)!.id}`,
        member.cookie,
        { size: 8 },
        "PUT",
      );
    expect((await set("acme/repo-101")).status).toBe(200);
    const refused = await set("acme/repo-102");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    // The workspace's default size stays with owners and admins.
    const size = await testing.call(
      env,
      `/workspaces/${workspace.id}/auto-size`,
      member.cookie,
      { size: 8 },
      "PUT",
    );
    expect(size.status).toBe(403);
  });
});

describe("sizes planned before a repo routes", () => {
  test("wait unseen for the job's first pick, which then runs at that size", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace, cookie: jar } = await testing.createWorkspace(
      env,
      cookie,
      "Planned",
      "planned",
    );
    const db = createDb(env.DB);
    const now = new Date();
    await db.insert(schema.githubRepository).values({
      id: 201,
      installationId: workspace.installationId,
      fullName: "acme/planned",
      private: true,
      githubStateAt: now,
    });
    await db.insert(schema.workflowRun).values({
      id: 9001,
      runAttempt: 1,
      installationId: workspace.installationId,
      repositoryId: 201,
      repositoryFullName: "acme/planned",
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      headSha: "abc",
      status: "completed",
      githubUpdatedAt: now,
    });

    const plan = (body: unknown) =>
      testing.call(env, `/workspaces/${workspace.id}/planned-sizes`, jar, body, "PUT");
    const saved = await plan({
      repositoryId: 201,
      jobs: [
        { workflow: "CI", job: "test", size: 8 },
        // A `name:` of its own, and a workflow with no recorded file: nothing to key them on.
        { workflow: "CI", job: "Unit tests", size: 4 },
        { workflow: "Nightly", job: "build", size: 4 },
      ],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ planned: [{ workflow: "CI", job: "test", size: 8 }] });

    // Not listed until it runs.
    const listed = async () =>
      (
        (await (await testing.call(env, `/workspaces/${workspace.id}/auto-jobs`, jar)).json()) as {
          jobs: { relayJob: string; size: number | null }[];
        }
      ).jobs;
    expect(await listed()).toEqual([]);

    const picked = await autoPick(db, {
      workspaceId: workspace.id,
      repositoryId: 201,
      relayJob: "relay-test",
      private: true,
      context: { ...context(), repo: "acme/planned" },
    });
    expect(picked.size).toBe(8);
    expect(await listed()).toMatchObject([{ relayJob: "relay-test", size: 8 }]);

    expect(
      (await plan({ repositoryId: 999, jobs: [{ workflow: "CI", job: "test", size: 8 }] })).status,
    ).toBe(404);
    expect(
      (await plan({ repositoryId: 201, jobs: [{ workflow: "CI", job: "test", size: 3 }] })).status,
    ).toBe(400);
  });
});

describe("shaped relays", () => {
  test("a shape sizes every provider, and cpus wins over the Router page's size", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Shape", "shape");
    const db = createDb(env.DB);
    const job = { workspaceId: workspace.id, repositoryId: 1, relayJob: "relay", private: true };

    const linux = await autoPick(db, {
      ...job,
      context: { ...context({ github: ["my-org-linux-16core"] }), shape: { cpus: 8 } },
    });
    expect(linux.size).toBe(8);
    expect(linux.platform).toBe("linux");
    expect(linux.inputs.blacksmith).toEqual(["blacksmith-8vcpu-ubuntu-2404"]);
    expect(linux.inputs.github).toEqual(["my-org-linux-16core"]);
    expect(linux.inputs.machine).toEqual(["self-hosted", "Linux"]);
    // Ubicloud has no macOS runners, and Blacksmith's are 6 vCPU.
    const mac = await autoPick(db, {
      ...job,
      context: { ...context(), shape: { os: "macos" } },
    });
    expect(mac.platform).toBe("macos");
    expect(mac.inputs.blacksmith).toEqual(["blacksmith-6vcpu-macos-latest"]);
    expect(mac.inputs.github).toEqual(["macos-latest"]);
    expect(mac.inputs.ubicloud).toEqual(["auto"]);
    expect(mac.inputs.machine).toEqual(["self-hosted", "macOS"]);

    // The Router page lists the file's size.
    const [row] = await db
      .select()
      .from(schema.autoJob)
      .where(eq(schema.autoJob.relayJob, "relay"));
    expect(row?.cpus).toBeNull();
    await autoPick(db, { ...job, context: { ...context(), shape: { cpus: 4 } } });
    const [after] = await db
      .select()
      .from(schema.autoJob)
      .where(eq(schema.autoJob.relayJob, "relay"));
    expect(after?.cpus).toBe(4);
  });

  test("a public repo counts GitHub's 4 vCPU standard runners", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Public", "public");
    const db = createDb(env.DB);
    const picked = await autoPick(db, {
      workspaceId: workspace.id,
      repositoryId: 1,
      relayJob: "relay",
      private: false,
      context: { ...context(), shape: { cpus: 4 } },
    });
    expect(picked.inputs.github).toEqual(["ubuntu-latest"]);
  });
});
