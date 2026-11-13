import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  splitEnvs,
  purgeOldWorkflowRuns,
  waitingMs,
  recordWorkflowRun,
  type PerformanceReport,
  type Run,
  type RunHeader,
  type RunJob,
  type RunsReport,
} from "./runs.ts";
import type { HistoryJob } from "./job-times.ts";
import * as testing from "./testing.ts";

vi.mock("./github-app.ts", async (original) => ({
  ...(await original<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));

afterEach(() => vi.unstubAllGlobals());

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const HOUR = 3_600_000;
let workspaces = 0;
let ids = 500_000;

async function connectedWorkspace() {
  workspaces += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Runs ${workspaces}`,
    `runs-${workspaces}`,
  );
  const installationId = 8000 + workspaces;
  await createDb(env.DB)
    .insert(schema.githubInstallation)
    .values({
      id: installationId,
      accountId: installationId,
      accountLogin: `runs-org-${workspaces}`,
      accountType: "Organization",
    });
  await testing.useInstallation(env, workspace.id, installationId);
  return { cookie, installationId, workspaceId: workspace.id, repositoryId: installationId * 10 };
}

type Timing = typeof schema.jobTiming.$inferInsert;

// A finished job: `seconds` long, ending `hoursAgo` hours ago, queued 5s before it started.
function timing(
  installationId: number,
  seconds: number,
  { hoursAgo = 1, ...job }: Partial<Timing> & { hoursAgo?: number } = {},
): Timing {
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
    name: "lint",
    labels: ["ubuntu-latest"],
    conclusion: "success",
    runnerName: "runner",
    runnerGroupName: "GitHub Actions",
    queuedAt: new Date(completed - seconds * 1000 - 5000),
    startedAt: new Date(completed - seconds * 1000),
    completedAt: new Date(completed),
    ...job,
  };
}

async function insert(rows: Timing[]) {
  const db = createDb(env.DB);
  for (let i = 0; i < rows.length; i += 5)
    await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));
}

function runMessage(
  installationId: number,
  run: Partial<Extract<WebhookMessage, { event: "workflow_run" }>["run"]> & { id: number },
): Extract<WebhookMessage, { event: "workflow_run" }> {
  return {
    event: "workflow_run",
    deliveryId: `d-${run.id}-${run.updatedAt}`,
    action: "completed",
    installationId,
    receivedAt: new Date().toISOString(),
    repository: { id: installationId * 10, fullName: "acme/app" },
    run: {
      runAttempt: 1,
      workflowName: "CI",
      displayTitle: "feat: add the runs page",
      event: "pull_request",
      actorLogin: "zach",
      startedBy: { id: 2, login: "zach" },
      triggeredBy: { id: 2, login: "zach" },
      headBranch: "runs-page",
      headSha: "abc",
      pullRequestNumber: 12,
      status: "completed",
      conclusion: "success",
      htmlUrl: `https://github.com/acme/app/actions/runs/${run.id}`,
      runStartedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      updatedAt: new Date(Date.now() - HOUR).toISOString(),
      ...run,
    },
  };
}

async function list(cookie: string) {
  const res = await testing.call(env, "/runs", cookie);
  if (res.status !== 200) throw new Error(await res.text());
  return (await res.json()) as RunsReport;
}

describe("recordWorkflowRun", () => {
  test("keeps the newest delivery, whatever order they arrive in", async () => {
    const { installationId } = await connectedWorkspace();
    const db = createDb(env.DB);
    const id = (ids += 1);
    const later = new Date(Date.now() - HOUR).toISOString();
    const earlier = new Date(Date.now() - 2 * HOUR).toISOString();
    await recordWorkflowRun(db, runMessage(installationId, { id, updatedAt: later }));
    // An in_progress delivery that arrives late doesn't rewind the finished run.
    await recordWorkflowRun(
      db,
      runMessage(installationId, {
        id,
        updatedAt: earlier,
        status: "in_progress",
        conclusion: null,
      }),
    );
    const rows = await db.select().from(schema.workflowRun);
    expect(rows.find((row) => row.id === id)).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    // An unknown installation is skipped.
    expect(await recordWorkflowRun(db, runMessage(1, { id: (ids += 1) }))).toBe(false);
  });

  test("purges runs past retention", async () => {
    const { installationId } = await connectedWorkspace();
    const db = createDb(env.DB);
    const old = (ids += 1);
    await recordWorkflowRun(
      db,
      runMessage(installationId, {
        id: old,
        updatedAt: new Date(Date.now() - 100 * 24 * HOUR).toISOString(),
      }),
    );
    expect(await purgeOldWorkflowRuns(db)).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(schema.workflowRun);
    expect(rows.some((row) => row.id === old)).toBe(false);
  });
});

describe("runs list", () => {
  test("joins run details to their jobs, times whole runs and works out the usual time", async () => {
    const { cookie, installationId, workspaceId } = await connectedWorkspace();
    const db = createDb(env.DB);
    const [machine] = await db
      .insert(schema.machine)
      .values({ id: `runs-mac-${installationId}`, workspaceId, name: "Zach's MacBook Pro" })
      .returning();
    const rows: Timing[] = [];
    // Five earlier successful CI runs of 60s each, days ago: they set the usual time.
    for (let i = 0; i < 5; i += 1)
      rows.push(timing(installationId, 60, { runId: 100 + i, hoursAgo: 48 + i }));
    // A routed run: the pick, then lint on the Mac and test on GitHub, which failed.
    rows.push(
      timing(installationId, 3, {
        runId: 200,
        name: "pick",
        labels: ["relayrunner"],
        hoursAgo: 1.1,
      }),
    );
    rows.push(
      timing(installationId, 30, {
        runId: 200,
        labels: ["rr-0123456789ab"],
        runnerGroupName: "Default",
        machineId: machine.id,
      }),
    );
    rows.push(timing(installationId, 90, { runId: 200, name: "test", conclusion: "failure" }));
    await insert(rows);
    await recordWorkflowRun(
      db,
      runMessage(installationId, { id: 200, conclusion: "failure", displayTitle: "fix: picks" }),
    );
    // A run still going: only its workflow_run is known.
    await recordWorkflowRun(
      db,
      runMessage(installationId, {
        id: 201,
        status: "in_progress",
        conclusion: null,
        updatedAt: new Date().toISOString(),
      }),
    );
    // Another workspace's run is never listed.
    const other = await connectedWorkspace();
    const theirJob = timing(other.installationId, 10, { runId: 999 });
    await insert([theirJob]);

    const week = await list(cookie);
    expect(week.days).toBe(14);
    expect(week.runs.map((run) => run.runId)).toEqual([201, 200, 100, 101, 102, 103, 104]);
    const [live, routed] = week.runs;
    expect(live).toMatchObject({ status: "in_progress", conclusion: null, wallMs: null });
    expect(routed).toMatchObject<Partial<Run>>({
      title: "fix: picks",
      event: "pull_request",
      actor: "zach",
      pullRequest: 12,
      status: "completed",
      conclusion: "failure",
      routed: true,
      usualMs: 65_000,
    });
    expect([...routed.environments].sort()).toEqual(
      [`machine:${machine.id}`, "github:linux-2-core"].sort(),
    );
    expect(week.environments.find((e) => e.key === `machine:${machine.id}`)?.label).toBe(
      "Zach's MacBook Pro",
    );
    // A run with no workflow_run row still shows, from its jobs.
    expect(week.runs[2]).toMatchObject({
      title: null,
      conclusion: "success",
      wallMs: 65_000,
      routed: false,
      url: "https://github.com/acme/app/actions/runs/100/attempts/1",
    });

    // Runs older than the window are left out.
    expect(week.runs.every((run) => run.updatedAt >= Date.now() - 14 * 24 * HOUR)).toBe(true);

    const res = await testing.call(env, `/runs/${installationId * 10}/200/1/jobs`, cookie);
    expect(res.status).toBe(200);
    const { run, jobs } = (await res.json()) as { run: RunHeader; jobs: RunJob[] };
    expect(run).toMatchObject({
      repository: "acme/app",
      workflow: "CI",
      title: "fix: picks",
      status: "completed",
      conclusion: "failure",
    });
    expect(jobs.map((job) => [job.name, job.conclusion])).toEqual([
      ["test", "failure"],
      ["lint", "success"],
    ]);

    // A job's steps come from GitHub, for the workspace's jobs only.
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
            started_at: "2026-11-12T10:00:00Z",
            completed_at: "2026-11-12T10:00:02Z",
          },
        ],
      });
    });
    const steps = await testing.call(env, `/runs/jobs/${jobs[0]!.id}/steps`, cookie);
    expect(steps.status).toBe(200);
    expect(await steps.json()).toEqual({
      steps: [
        {
          number: 1,
          name: "Set up job",
          status: "completed",
          conclusion: "success",
          startedAt: Date.parse("2026-11-12T10:00:00Z"),
          completedAt: Date.parse("2026-11-12T10:00:02Z"),
        },
      ],
    });
    expect(requested).toEqual([
      `https://api.github.com/repos/acme/app/actions/jobs/${jobs[0]!.id}`,
    ]);
    // The live run's jobs show while they're still going: one running, one waiting for the Mac.
    const now = Date.now();
    await insert([
      timing(installationId, 0, {
        runId: 201,
        name: "build",
        conclusion: null,
        queuedAt: new Date(now - 70_000),
        startedAt: new Date(now - 60_000),
        completedAt: null,
      }),
      timing(installationId, 0, {
        runId: 201,
        name: "e2e",
        labels: ["rr-0123456789ab"],
        machineId: machine.id,
        conclusion: null,
        runnerName: null,
        runnerGroupName: null,
        queuedAt: new Date(now - 30_000),
        startedAt: null,
        completedAt: null,
      }),
    ]);
    // Still going, so the run list doesn't count them.
    expect((await list(cookie)).runs[0]).toMatchObject({ runId: 201, environments: [] });
    const liveRes = await testing.call(env, `/runs/${installationId * 10}/201/1/jobs`, cookie);
    const liveJobs = (await liveRes.json()) as { environments: { key: string }[]; jobs: RunJob[] };
    expect(liveJobs.jobs).toMatchObject([
      { name: "build", status: "in_progress", environment: "github:linux-2-core" },
      { name: "e2e", status: "queued", environment: `machine:${machine.id}`, startedAt: null },
    ]);

    // The other workspace's run isn't reachable by id.
    const theirs = await testing.call(env, `/runs/${other.installationId * 10}/999/1/jobs`, cookie);
    expect(await theirs.json()).toMatchObject({ run: null, jobs: [] });
    expect((await testing.call(env, `/runs/jobs/${theirJob.id}/steps`, cookie)).status).toBe(404);
  });
});

describe("workflow times and the job list", () => {
  test("times whole workflow runs from their newest successful runs", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    const rows: Timing[] = [];
    // Five CI runs: lint then test, one after the other. Each run is 5s of queue, then 20s + 40s.
    for (let i = 0; i < 5; i++) {
      const runId = (ids += 1);
      rows.push(
        timing(installationId, 20, { runId, hoursAgo: i + 1 + 40_000 / HOUR }),
        timing(installationId, 40, { runId, name: "test", hoursAgo: i + 1 }),
      );
    }
    // A failed run counts as a run, not in the times.
    rows.push(timing(installationId, 5, { conclusion: "failure" }));
    await insert(rows);

    const res = await testing.call(env, "/job-times", cookie);
    const report = (await res.json()) as PerformanceReport;
    const ci = report.workflows.find((row) => row.workflow === "CI");
    // First queued (5s before lint started) to test finishing: 5 + 20 + 40 = 65s. test queued
    // while lint ran, so only lint's 5s queue had no job running.
    expect(ci?.wall).toMatchObject({
      runs: 6,
      successes: 5,
      samples: 5,
      medianMs: 65_000,
      waitMs: 5_000,
    });
  });

  test("counts time with no job running as waiting, overlapping jobs once", () => {
    // 0-100: a waits until 10, runs 10-40 beside b (20-50), nothing runs 50-70, c runs 70-90,
    // then 10 more until the run ends.
    expect(waitingMs(0, 100, "10:40,20:50,70:90")).toBe(10 + 20 + 10);
    // A job wholly inside another counts nothing extra; spans past the run are clipped.
    expect(waitingMs(0, 100, "0:80,10:20,90:150")).toBe(10);
    expect(waitingMs(0, 100, null)).toBe(100);
  });

  test("lists finished jobs newest first, picks and other workspaces left out", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    const other = await connectedWorkspace();
    await insert([
      timing(other.installationId, 10, { name: "theirs", hoursAgo: 2 }),
      timing(installationId, 10, { name: "older", hoursAgo: 3 }),
      timing(installationId, 10, { name: "newer", hoursAgo: 1 }),
      timing(installationId, 2, { name: "pick", labels: ["relayrunner"] }),
      // Outside a 1-day window.
      timing(installationId, 10, { name: "old", hoursAgo: 30 }),
    ]);
    const res = await testing.call(env, "/runs/jobs?days=1", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: HistoryJob[]; truncated: boolean };
    expect(body.jobs.map((job) => job.name)).toEqual(["newer", "older"]);
    expect(body.jobs[0]).toMatchObject({
      repository: "acme/app",
      workflow: "CI",
      environment: "github:linux-2-core",
    });
    expect(body.truncated).toBe(false);
  });
});

test("splitEnvs reads each environment", () => {
  const text = `["ubuntu-latest"]\u001fGitHub Actions\u001f\u001e,["rr-1"]\u001fDefault\u001fm1\u001e`;
  expect(splitEnvs(text)).toEqual([
    `["ubuntu-latest"]\u001fGitHub Actions\u001f`,
    `["rr-1"]\u001fDefault\u001fm1`,
  ]);
  expect(splitEnvs(null)).toEqual([]);
});
