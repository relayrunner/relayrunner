import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  confidence,
  environmentFor,
  type JobTimesReport,
  quantile,
  SAMPLE_CAP,
  type Stat,
  statOf,
  versusBaseline,
  windowQueries,
} from "./job-times.ts";
import { recordJobTiming } from "./job-timings.ts";
import { setJobMachine } from "./jobs.ts";
import * as testing from "./testing.ts";

describe("environmentFor", () => {
  test.each([
    [["ubuntu-latest"], "GitHub Actions", null, "github:linux-2-core", "Linux 2-core"],
    [["ubuntu-24.04"], null, null, "github:linux-2-core", "Linux 2-core"],
    [["macos-15"], null, null, "github:macos", "macOS"],
    [
      ["ubuntu-latest-8-cores"],
      "GitHub Actions",
      null,
      "github:ubuntu-latest-8-cores",
      "ubuntu-latest-8-cores",
    ],
    [["relayrunner-container"], "Default Public", null, "container", "Cloudflare Container"],
    [
      ["blacksmith-2vcpu-ubuntu-2404"],
      null,
      null,
      "blacksmith:blacksmith-2vcpu-ubuntu-2404",
      "blacksmith-2vcpu-ubuntu-2404",
    ],
    [["rr-0123456789ab"], "Default", "m1", "machine:m1", "Machine"],
    [["rr-0123456789ab"], "Default", null, "self-hosted:Default", "Self-hosted"],
    [["self-hosted", "linux"], null, null, "self-hosted:Default", "Self-hosted"],
  ] as const)("%j in %s on machine %s is %s", (labels, group, machine, key, label) => {
    expect(environmentFor([...labels], group, machine)).toMatchObject({ key, label });
  });
});

describe("stats", () => {
  test("quantiles interpolate", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([0, 100], 0.9)).toBe(90);
  });

  test("confidence follows the sample size", () => {
    expect([0, 1, 4, 5, 19, 20].map(confidence)).toEqual([
      "none",
      "few",
      "few",
      "low",
      "low",
      "ok",
    ]);
  });

  test("keeps the newest runs and compares the newer half with the older", () => {
    // 60 runs, one a minute: the newest 30 took 20s, the older 30 took 10s.
    const samples = Array.from({ length: 60 }, (_, i) => ({
      completedAt: 1_000_000 - i * 60_000,
      runMs: i < 30 ? 20_000 : 10_000,
      waitMs: 1_000,
    }));
    const stat = statOf({ runs: 64, successes: 60, samples });
    expect(stat).toMatchObject({ runs: 64, successes: 60, samples: SAMPLE_CAP, waitMs: 1_000 });
    // The cap drops the 10 oldest 10s runs: 30 at 20s, 20 at 10s.
    expect(stat.medianMs).toBe(20_000);
    expect(stat.trend).toBe(1);
  });

  test("compares environments only on jobs both ran enough", () => {
    const stat = (medianMs: number, samples = 20) => ({
      ...statOf({ runs: 0, successes: 0, samples: [] }),
      medianMs,
      samples,
    });
    const jobs: Record<string, Stat>[] = [
      // Twice as fast on one, twice as slow on another: even.
      { base: stat(100), mac: stat(50) },
      { base: stat(100), mac: stat(200) },
      // Too few runs on the Mac: left out.
      { base: stat(100), mac: stat(10, 3) },
      // Never ran on the Mac.
      { base: stat(100) },
    ];
    expect(versusBaseline(jobs, "mac", "base")).toEqual({ ratio: 1, sharedJobs: 2 });
    expect(versusBaseline([{ base: stat(100) }], "mac", "base")).toBeNull();
  });
});

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

let workspaces = 0;
let jobIds = 900_000;
const HOUR = 3_600_000;

async function connectedWorkspace() {
  workspaces += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Times ${workspaces}`,
    `times-${workspaces}`,
  );
  const installationId = 7000 + workspaces;
  await createDb(env.DB)
    .insert(schema.githubInstallation)
    .values({
      id: installationId,
      workspaceId: workspace.id,
      accountId: installationId,
      accountLogin: `times-org-${workspaces}`,
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
  jobIds += 1;
  const completed = Date.now() - hoursAgo * HOUR;
  return {
    id: jobIds,
    installationId,
    repositoryId: installationId * 10,
    repositoryFullName: "acme/app",
    runId: jobIds,
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
  // D1 caps bound parameters per statement.
  for (let i = 0; i < rows.length; i += 5)
    await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));
}

async function report(cookie: string, query = "") {
  const res = await testing.call(env, `/job-times${query}`, cookie);
  if (res.status !== 200) throw new Error(await res.text());
  return (await res.json()) as JobTimesReport;
}

describe("job times report", () => {
  test("times each job per environment, folds matrix legs and times whole runs", async () => {
    const { cookie, installationId, workspaceId } = await connectedWorkspace();
    const db = createDb(env.DB);
    const [machine] = await db
      .insert(schema.machine)
      .values({
        id: `times-mac-${installationId}`,
        workspaceId,
        name: "Zach's MacBook Pro",
        deviceModel: "MacBook Pro",
        chip: "Apple M3 Max",
      })
      .returning();
    const rows: Timing[] = [];
    for (let i = 0; i < 6; i += 1) {
      // Linux runs: lint 40s, test legs 180s and 200s, all in one run.
      const runId = 100 + i;
      rows.push(timing(installationId, 40, { runId, hoursAgo: i + 1 }));
      rows.push(timing(installationId, 180, { runId, name: "test (node 22)", hoursAgo: i + 1 }));
      rows.push(timing(installationId, 200, { runId, name: "test (node 24)", hoursAgo: i + 1 }));
      // The pick job of that run: left out, so the run stays on one environment.
      rows.push(
        timing(installationId, 3, {
          runId,
          name: "pick",
          labels: ["relayrunner"],
          hoursAgo: i + 1,
        }),
      );
      // Mac runs of lint, on a route's label.
      rows.push(
        timing(installationId, 10, {
          runId: 200 + i,
          labels: ["rr-0123456789ab"],
          runnerGroupName: "Default",
          machineId: machine.id,
          hoursAgo: i + 1,
        }),
      );
    }
    // A failure: counted as a run, not in the times. A skipped job: not counted at all.
    rows.push(timing(installationId, 5, { conclusion: "failure" }));
    rows.push(timing(installationId, 0, { conclusion: "skipped" }));
    // Out of the 14-day window.
    rows.push(timing(installationId, 999, { hoursAgo: 15 * 24 }));
    // A run split between Linux and a container: no whole-run time.
    rows.push(timing(installationId, 40, { runId: 300 }));
    rows.push(
      timing(installationId, 20, { runId: 300, name: "oxlint", labels: ["relayrunner-container"] }),
    );
    await insert(rows);

    const result = await report(cookie);
    expect(result).toMatchObject({
      days: 14,
      sampleCap: SAMPLE_CAP,
      baseline: "github:linux-2-core",
    });
    const linux = result.environments.find((env) => env.key === "github:linux-2-core");
    const mac = result.environments.find((env) => env.key === `machine:${machine.id}`);
    expect(linux?.stat).toMatchObject({ runs: 20, successes: 19 });
    expect(mac).toMatchObject({
      label: "Zach's MacBook Pro",
      detail: "MacBook Pro · Apple M3 Max",
    });
    expect(mac?.stat).toMatchObject({
      runs: 6,
      medianMs: 10_000,
      waitMs: 5_000,
      confidence: "low",
    });
    // Lint is the only shared job: 10s against 40s.
    expect(mac?.versus).toEqual({ ratio: 0.25, sharedJobs: 1 });

    expect(result.workflows).toHaveLength(1);
    const [ci] = result.workflows;
    expect(ci.jobs.map((job) => job.name)).toEqual(["lint", "test", "oxlint"]);
    const test = ci.jobs[1];
    expect(test.legs?.map((leg) => leg.name)).toEqual(["test (node 22)", "test (node 24)"]);
    expect(test.byEnvironment["github:linux-2-core"]).toMatchObject({
      samples: 12,
      medianMs: 190_000,
    });
    const lint = ci.jobs[0].byEnvironment;
    expect(lint["github:linux-2-core"]).toMatchObject({ runs: 8, successes: 7, medianMs: 40_000 });
    // Whole runs: 6 Linux runs of 200s (the longest leg) plus the failed one, 6 Mac runs, and none
    // for the split run.
    expect(ci.byEnvironment["github:linux-2-core"]).toMatchObject({
      runs: 7,
      successes: 6,
      samples: 6,
    });
    expect(ci.byEnvironment["github:linux-2-core"].medianMs).toBe(200_000);
    expect(ci.byEnvironment[`machine:${machine.id}`]).toMatchObject({ samples: 6 });
    expect(ci.byEnvironment.container).toBeUndefined();

    const machines = await testing.call(env, "/job-times/machines", cookie);
    const { machines: byMachine } = (await machines.json()) as { machines: Record<string, Stat> };
    expect(byMachine).toEqual({
      [machine.id]: expect.objectContaining({ runs: 6, medianMs: 10_000 }),
    });
  });

  test("reads only the workspace's window, once", async () => {
    const mine = await connectedWorkspace();
    const other = await connectedWorkspace();
    const rows: Timing[] = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push(timing(mine.installationId, 30, { name: `job ${i % 3}` }));
      // Older than the window, and another workspace's: never read.
      rows.push(timing(mine.installationId, 30, { hoursAgo: 20 * 24 }));
      rows.push(timing(other.installationId, 30));
      rows.push(timing(other.installationId, 30));
    }
    await insert(rows);
    const db = createDb(env.DB);
    const since = new Date(Date.now() - 14 * 24 * HOUR);
    const read = async () => {
      const { jobs, runs } = windowQueries(mine.workspaceId, since);
      return [(await db.run(jobs)).meta.rows_read, (await db.run(runs)).meta.rows_read];
    };
    const before = await read();
    // 2 to 3 per row in the window (the index range plus the GROUP BY sorters), each.
    for (const rowsRead of before) expect(rowsRead).toBeLessThan(4 * 30);
    // More rows outside the window don't change what's read.
    await insert(
      rows
        .filter((row) => row.installationId !== mine.installationId)
        .map((row) => ({ ...row, id: (jobIds += 1) })),
    );
    expect(await read()).toEqual(before);
  });

  test("one job's runs, legs included, newest first", async () => {
    const { cookie, installationId, repositoryId } = await connectedWorkspace();
    await insert([
      timing(installationId, 10, { name: "test (a)", hoursAgo: 3 }),
      timing(installationId, 20, { name: "test (b)", hoursAgo: 2 }),
      timing(installationId, 30, { name: "testing", hoursAgo: 1 }),
      timing(installationId, 40, { name: "test (c)", conclusion: "failure", hoursAgo: 4 }),
    ]);
    const res = await testing.call(
      env,
      `/job-times/runs?repositoryId=${repositoryId}&workflow=CI&name=test&matrix=true`,
      cookie,
    );
    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as {
      runs: { conclusion: string; startedAt: number; completedAt: number; environment: string }[];
    };
    expect(runs.map((run) => (run.completedAt - run.startedAt) / 1000)).toEqual([20, 10, 40]);
    expect(runs[2].conclusion).toBe("failure");
    expect(new Set(runs.map((run) => run.environment))).toEqual(new Set(["github:linux-2-core"]));
    // Another workspace can't read them.
    const { cookie: stranger } = await connectedWorkspace();
    const theirs = await testing.call(
      env,
      `/job-times/runs?repositoryId=${repositoryId}&workflow=CI&name=test&matrix=true`,
      stranger,
    );
    expect(((await theirs.json()) as { runs: unknown[] }).runs).toHaveLength(0);
  });

  test("records the queued time and the routed machine", async () => {
    const { installationId, workspaceId } = await connectedWorkspace();
    const db = createDb(env.DB);
    await db
      .insert(schema.machine)
      .values({ id: `rec-${installationId}`, workspaceId, name: "box" });
    jobIds += 1;
    const jobId = jobIds;
    await db.insert(schema.workflowJob).values({
      id: jobId,
      installationId,
      repositoryId: installationId * 10,
      repositoryFullName: "acme/app",
      runId: jobId,
      runAttempt: 1,
      kind: "job",
      name: "lint",
      labels: ["rr-0123456789ab"],
      headSha: "abc",
      status: "in_progress",
      machineId: `rec-${installationId}`,
      githubCreatedAt: new Date(),
    });
    const now = Date.now();
    await recordJobTiming(db, {
      event: "workflow_job",
      deliveryId: `rec-${jobId}`,
      action: "completed",
      installationId,
      receivedAt: new Date(now).toISOString(),
      repository: { id: installationId * 10, fullName: "acme/app" },
      job: {
        id: jobId,
        runId: jobId,
        runAttempt: 1,
        name: "lint",
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        labels: ["rr-0123456789ab"],
        headBranch: "main",
        headSha: "abc",
        runnerName: "box",
        runnerGroupName: "Default",
        createdAt: new Date(now - 20_000).toISOString(),
        startedAt: new Date(now - 15_000).toISOString(),
        completedAt: new Date(now).toISOString(),
      },
    });
    // The route's webhook handling notes the machine on both rows.
    await setJobMachine(db, jobId, `rec-${installationId}`);
    const row = await db.query.jobTiming.findFirst({ where: (t, { eq }) => eq(t.id, jobId) });
    expect(row).toMatchObject({ machineId: `rec-${installationId}` });
    expect(row?.queuedAt?.getTime()).toBe(now - 20_000);
  });
});
