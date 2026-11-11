import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  splitEnvs,
  purgeOldWorkflowRuns,
  recordWorkflowRun,
  type Run,
  type RunJob,
  type RunsReport,
} from "./runs.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
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
      workspaceId: workspace.id,
      accountId: installationId,
      accountLogin: `runs-org-${workspaces}`,
      accountType: "Organization",
    });
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
    await insert([timing(other.installationId, 10, { runId: 999 })]);

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
    const { jobs } = (await res.json()) as { jobs: RunJob[] };
    expect(jobs.map((job) => [job.name, job.conclusion])).toEqual([
      ["test", "failure"],
      ["lint", "success"],
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
    expect(((await theirs.json()) as { jobs: RunJob[] }).jobs).toEqual([]);
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
