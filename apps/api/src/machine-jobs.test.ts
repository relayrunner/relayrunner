import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { app } from "./app.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { forgetRecentFailures } from "./job-failures.ts";
import { forgetMachineJobs } from "./machine-jobs.ts";
import { sha256Hex } from "./machines.ts";
import * as testing from "./testing.ts";

vi.mock("./github-app.ts", async (original) => ({
  ...(await original<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));

afterEach(() => {
  vi.unstubAllGlobals();
  forgetRecentFailures();
  forgetMachineJobs();
});

let env: Env;
beforeAll(async () => {
  env = await testing.createTestEnv();
});

const HOUR = 3_600_000;
let count = 0;
let ids = 900_000;

// A workspace on its own installation with one connected machine in it, and the machine's token.
async function machineInWorkspace() {
  count += 1;
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(
    env,
    cookie,
    `Jobs ${count}`,
    `jobs-${count}`,
  );
  const installationId = 9100 + count;
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: `jobs-org-${count}`,
    accountType: "Organization",
  });
  await testing.useInstallation(env, workspace.id, installationId);
  const token = `rrm_machine-jobs-${count}`;
  const machineId = `mach_jobs_${count}`;
  await db.insert(schema.machine).values({
    id: machineId,
    name: `box-${count}`,
    tokenHash: await sha256Hex(token),
  });
  await db.insert(schema.machineWorkspace).values({ machineId, workspaceId: workspace.id });
  return { token, machineId, installationId, workspaceId: workspace.id };
}

type Timing = typeof schema.jobTiming.$inferInsert;
function job(
  installationId: number,
  { hoursAgo = 1, ...rest }: Partial<Timing> & { hoursAgo?: number },
) {
  ids += 1;
  const completed = Date.now() - hoursAgo * HOUR;
  return {
    id: ids,
    installationId,
    repositoryId: installationId * 10,
    repositoryFullName: "acme/app",
    runId: ids,
    runAttempt: 1,
    workflowName: "CI",
    name: "test",
    labels: ["self-hosted"],
    conclusion: "success",
    queuedAt: new Date(completed - 65_000),
    startedAt: new Date(completed - 60_000),
    completedAt: new Date(completed),
    ...rest,
  } satisfies Timing;
}

const get = (path: string, token?: string) =>
  app.request(
    `/api/machines/me${path}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
    env,
  );

describe("a machine's own jobs", () => {
  test("lists only the jobs that ran on it, newest first, a page at a time", async () => {
    const { token, machineId, installationId } = await machineInWorkspace();
    const other = await machineInWorkspace();
    const older = job(installationId, { machineId, hoursAgo: 3, name: "lint" });
    const newer = job(installationId, { machineId, hoursAgo: 1, conclusion: "failure" });
    const running = job(installationId, { machineId, completedAt: null, conclusion: null });
    const elsewhere = job(other.installationId, { machineId: other.machineId });
    const hosted = job(installationId, { labels: ["ubuntu-latest"] });
    await createDb(env.DB)
      .insert(schema.jobTiming)
      .values([older, newer, running, elsewhere, hosted]);

    const first = await get("/jobs?limit=1", token);
    expect(first.status).toBe(200);
    const page = (await first.json()) as { jobs: { id: number }[]; next: number | null };
    expect(page.jobs).toEqual([
      {
        id: newer.id,
        name: "test",
        workflow: "CI",
        repo: "acme/app",
        url: `https://github.com/acme/app/actions/runs/${newer.runId}/job/${newer.id}`,
        runId: newer.runId,
        runAttempt: 1,
        conclusion: "failure",
        failedStep: null,
        queuedAt: newer.queuedAt?.getTime(),
        startedAt: newer.startedAt?.getTime(),
        completedAt: newer.completedAt?.getTime(),
      },
    ]);
    expect(page.next).toBe(newer.completedAt?.getTime());

    const rest = (await (await get(`/jobs?before=${page.next}`, token)).json()) as typeof page;
    expect(rest.jobs.map((row) => row.id)).toEqual([older.id]);
    expect(rest.next).toBeNull();
  });

  test("puts the jobs running or waiting here first, and offers its repos and workflows", async () => {
    const { token, machineId, installationId } = await machineInWorkspace();
    const done = job(installationId, { machineId, hoursAgo: 2 });
    const started = Date.now() - 60_000;
    const running = job(installationId, {
      machineId,
      repositoryFullName: "acme/api",
      workflowName: "Deploy",
      conclusion: null,
      startedAt: new Date(started),
      completedAt: null,
    });
    const waiting = job(installationId, {
      machineId,
      conclusion: null,
      queuedAt: new Date(started + 10_000),
      startedAt: null,
      completedAt: null,
    });
    // Lost its `completed` webhook two days ago.
    const stuck = job(installationId, {
      machineId,
      conclusion: null,
      queuedAt: new Date(Date.now() - 49 * HOUR),
      startedAt: new Date(Date.now() - 48 * HOUR),
      completedAt: null,
      createdAt: new Date(Date.now() - 49 * HOUR),
    });
    await createDb(env.DB).insert(schema.jobTiming).values([done, running, waiting, stuck]);

    const page = (await (await get("/jobs", token)).json()) as {
      jobs: { id: number }[];
      active: { id: number }[];
      repos: string[];
      workflows: string[];
    };
    expect(page.jobs.map((row) => row.id)).toEqual([done.id]);
    expect(page.active.map((row) => row.id)).toEqual([running.id, waiting.id]);
    expect(page.repos).toEqual(["acme/app"]);
    expect(page.workflows).toEqual(["CI"]);

    const older = (await (await get(`/jobs?before=${Date.now()}`, token)).json()) as object;
    expect(older).not.toHaveProperty("active");
    const failed = (await (await get("/jobs?result=failed", token)).json()) as typeof page;
    expect(failed.active).toEqual([]);
  });

  test("filters by repo, workflow, result and time", async () => {
    const { token, machineId, installationId } = await machineInWorkspace();
    const passed = job(installationId, { machineId, hoursAgo: 1 });
    const failed = job(installationId, { machineId, hoursAgo: 2, conclusion: "timed_out" });
    const canceled = job(installationId, { machineId, hoursAgo: 3, conclusion: "cancelled" });
    const api = job(installationId, {
      machineId,
      hoursAgo: 4,
      repositoryFullName: "acme/api",
      workflowName: "Deploy",
    });
    const old = job(installationId, { machineId, hoursAgo: 30 });
    await createDb(env.DB).insert(schema.jobTiming).values([passed, failed, canceled, api, old]);
    const ids = async (query: string) =>
      ((await (await get(`/jobs?${query}`, token)).json()) as { jobs: { id: number }[] }).jobs.map(
        (row) => row.id,
      );

    expect(await ids("result=succeeded")).toEqual([passed.id, api.id, old.id]);
    expect(await ids("result=failed")).toEqual([failed.id]);
    expect(await ids("result=canceled")).toEqual([canceled.id]);
    expect(await ids("repo=acme%2Fapi")).toEqual([api.id]);
    expect(await ids("workflow=CI&result=succeeded")).toEqual([passed.id, old.id]);
    expect(await ids(`since=${Date.now() - 24 * HOUR}&result=succeeded`)).toEqual([
      passed.id,
      api.id,
    ]);
    const facets = (await (await get("/jobs", token)).json()) as { repos: string[] };
    expect(facets.repos).toEqual(["acme/app", "acme/api"]);
    expect((await get("/jobs?result=maybe", token)).status).toBe(400);
  });

  test("gives one of them with its steps, and nothing for a job that ran elsewhere", async () => {
    const { token, machineId, installationId } = await machineInWorkspace();
    const other = await machineInWorkspace();
    const mine = job(installationId, { machineId });
    const theirs = job(other.installationId, { machineId: other.machineId });
    await createDb(env.DB).insert(schema.jobTiming).values([mine, theirs]);
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requested.push(url);
      return Response.json({
        steps: [
          {
            number: 1,
            name: "Set up job",
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-18T10:00:00Z",
            completed_at: "2026-11-18T10:00:02Z",
          },
        ],
      });
    });

    const res = await get(`/jobs/${mine.id}`, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      job: { id: mine.id, name: "test" },
      steps: [
        {
          number: 1,
          name: "Set up job",
          startedAt: Date.parse("2026-11-18T10:00:00Z"),
          completedAt: Date.parse("2026-11-18T10:00:02Z"),
        },
      ],
    });
    expect(requested).toEqual([`https://api.github.com/repos/acme/app/actions/jobs/${mine.id}`]);
    // A finished job's steps are kept.
    expect((await get(`/jobs/${mine.id}`, token)).status).toBe(200);
    expect(requested).toHaveLength(1);

    expect((await get(`/jobs/${theirs.id}`, token)).status).toBe(404);
    expect((await get(`/jobs/${theirs.id}/failure`, token)).status).toBe(404);
    expect((await get("/jobs/nope", token)).status).toBe(400);
  });

  test("says why one of them failed", async () => {
    const { token, machineId, installationId } = await machineInWorkspace();
    const failed = job(installationId, {
      machineId,
      conclusion: "failure",
      failedStep: "3. Run tests",
      ranSteps: true,
    });
    const passed = job(installationId, { machineId });
    await createDb(env.DB).insert(schema.jobTiming).values([failed, passed]);
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/rate_limit"))
        return Response.json({
          resources: { core: { limit: 5000, used: 0, remaining: 5000, reset: 2e9 } },
        });
      if (url.endsWith("/annotations")) return Response.json([{ message: "exit code 1" }]);
      if (/\/jobs\/\d+$/.test(url)) return Response.json({ steps: [] });
      return new Response("2026-11-18T10:00:00Z ok\n2026-11-18T10:00:01Z ##[error]boom\n");
    });

    const res = await get(`/jobs/${failed.id}/failure`, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: failed.id,
      failedStep: "3. Run tests",
      annotations: ["exit code 1"],
      log: ["ok", "##[error]boom"],
    });
    expect((await get(`/jobs/${passed.id}/failure`, token)).status).toBe(404);
    // The job itself comes with it, and a passed one with none.
    expect(await (await get(`/jobs/${failed.id}`, token)).json()).toMatchObject({
      job: { id: failed.id },
      failure: { failedStep: "3. Run tests", annotations: ["exit code 1"] },
    });
    expect(await (await get(`/jobs/${passed.id}`, token)).json()).toMatchObject({ failure: null });
  });

  test("needs the machine's own token", async () => {
    const { token } = await machineInWorkspace();
    const { cookie } = await testing.signIn(env);
    expect((await get("/jobs")).status).toBe(401);
    expect((await get("/jobs", "rrm_nope")).status).toBe(401);
    expect((await app.request("/api/machines/me/jobs", { headers: { cookie } }, env)).status).toBe(
      401,
    );
    expect((await get("/jobs", token)).status).toBe(200);
  });
});
