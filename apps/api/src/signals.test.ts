import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { InstallationTask } from "./installation-tasks.ts";
import { enqueueSignalRollups, rollUpSignals, type SignalsReport } from "./signals.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const MINUTE = 60_000;
// One moment for every helper, so runs line up to the millisecond.
const NOW = Date.now();
let workspaces = 0;
let ids = 900_000;

async function connectedWorkspace({ isPrivate = true } = {}) {
  workspaces += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Signals ${workspaces}`,
    `signals-${workspaces}`,
  );
  const installationId = 9100 + workspaces;
  const repositoryId = installationId * 10;
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: `signals-org-${workspaces}`,
    accountType: "Organization",
  });
  await db.insert(schema.githubRepository).values({
    id: repositoryId,
    installationId,
    fullName: "acme/app",
    private: isPrivate,
    githubStateAt: new Date(),
  });
  await testing.useInstallation(env, workspace.id, installationId);
  return { cookie, installationId, repositoryId };
}

type Ctx = Awaited<ReturnType<typeof connectedWorkspace>>;

// A finished run attempt and its one job, which ran from `start` for `minutes` (both minutes ago).
async function runWithJob(
  { installationId, repositoryId }: Ctx,
  {
    start,
    minutes,
    ...run
  }: { start: number; minutes: number } & Partial<typeof schema.workflowRun.$inferInsert>,
) {
  ids += 1;
  const startedAt = NOW - start * MINUTE;
  const completedAt = startedAt + minutes * MINUTE;
  const db = createDb(env.DB);
  await db.insert(schema.workflowRun).values({
    id: ids,
    runAttempt: 1,
    installationId,
    repositoryId,
    repositoryFullName: "acme/app",
    workflowName: "CI",
    workflowId: 7,
    workflowPath: ".github/workflows/ci.yml",
    defaultBranch: "main",
    event: "pull_request",
    headBranch: "feature",
    headSha: `sha-${ids}`,
    status: "completed",
    conclusion: "success",
    runStartedAt: new Date(startedAt),
    githubUpdatedAt: new Date(completedAt),
    ...run,
  });
  await db.insert(schema.jobTiming).values({
    id: ids,
    installationId,
    repositoryId,
    repositoryFullName: "acme/app",
    runId: ids,
    runAttempt: 1,
    workflowName: run.workflowName ?? "CI",
    name: "test",
    labels: ["ubuntu-latest"],
    conclusion: run.conclusion === "cancelled" ? "cancelled" : "success",
    runnerName: "runner",
    runnerGroupName: "GitHub Actions",
    queuedAt: new Date(startedAt),
    startedAt: new Date(startedAt),
    completedAt: new Date(completedAt),
  });
  return ids;
}

async function shortJobs(
  { installationId, repositoryId }: Ctx,
  count: number,
  { seconds = 15, name = "lint" } = {},
) {
  const db = createDb(env.DB);
  for (let i = 0; i < count; i += 1) {
    ids += 1;
    const completedAt = NOW - (i + 1) * MINUTE;
    await db.insert(schema.jobTiming).values({
      id: ids,
      installationId,
      repositoryId,
      repositoryFullName: "acme/app",
      runId: ids,
      runAttempt: 1,
      workflowName: "Lint",
      name,
      labels: ["ubuntu-latest"],
      conclusion: "success",
      runnerName: "runner",
      runnerGroupName: "GitHub Actions",
      queuedAt: new Date(completedAt - seconds * 1000),
      startedAt: new Date(completedAt - seconds * 1000),
      completedAt: new Date(completedAt),
    });
  }
}

// One finished job, `start` minutes ago for `minutes`, queued `waited` minutes before it started.
async function job(
  { installationId, repositoryId }: Ctx,
  {
    start,
    minutes,
    waited = 0,
    ...rest
  }: { start: number; minutes: number; waited?: number } & Partial<
    typeof schema.jobTiming.$inferInsert
  >,
) {
  ids += 1;
  const startedAt = NOW - start * MINUTE;
  await createDb(env.DB)
    .insert(schema.jobTiming)
    .values({
      id: ids,
      installationId,
      repositoryId,
      repositoryFullName: "acme/app",
      runId: ids,
      runAttempt: 1,
      workflowName: "CI",
      name: "test",
      labels: ["ubuntu-latest"],
      conclusion: "success",
      runnerName: "runner",
      runnerGroupName: "GitHub Actions",
      queuedAt: new Date(startedAt - waited * MINUTE),
      startedAt: new Date(startedAt),
      completedAt: new Date(startedAt + minutes * MINUTE),
      ...rest,
    });
}

// The workflow_run row for a run's re-run `attempt`, started `start` minutes ago.
async function rerun(
  { installationId, repositoryId }: Ctx,
  id: number,
  attempt: number,
  start: number,
) {
  await createDb(env.DB)
    .insert(schema.workflowRun)
    .values({
      id,
      runAttempt: attempt,
      installationId,
      repositoryId,
      repositoryFullName: "acme/app",
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      event: "pull_request",
      headSha: `sha-${id}`,
      status: "completed",
      conclusion: "success",
      runStartedAt: new Date(NOW - start * MINUTE),
      githubUpdatedAt: new Date(NOW - start * MINUTE + 5 * MINUTE),
    });
}

async function dayRows(installationId: number, signal: string) {
  return createDb(env.DB)
    .select()
    .from(schema.signalDay)
    .where(eq(schema.signalDay.installationId, installationId))
    .then((rows) => rows.filter((row) => row.signal === signal));
}

function sum(rows: { count: number; runMs: number }[]) {
  return {
    count: rows.reduce((total, row) => total + row.count, 0),
    minutes: rows.reduce((total, row) => total + row.runMs, 0) / MINUTE,
  };
}

async function report(cookie: string) {
  const res = await testing.call(env, "/signals?days=7", cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as SignalsReport;
}

describe("rollUpSignals", () => {
  test("counts the part of a run that kept going after a newer push to its branch", async () => {
    const ctx = await connectedWorkspace();
    // 60 minutes long; the next push started 20 minutes in, so 40 minutes were superseded.
    await runWithJob(ctx, { start: 120, minutes: 60 });
    await runWithJob(ctx, { start: 100, minutes: 30 });
    // Cancelled when the newer run started: concurrency is on, nothing to count.
    await runWithJob(ctx, {
      start: 300,
      minutes: 30,
      headBranch: "other",
      conclusion: "cancelled",
    });
    await runWithJob(ctx, { start: 290, minutes: 30, headBranch: "other" });
    // The default branch keeps every run, so it's left out.
    await runWithJob(ctx, { start: 500, minutes: 30, headBranch: "main", event: "push" });
    await runWithJob(ctx, { start: 490, minutes: 30, headBranch: "main", event: "push" });

    await rollUpSignals(createDb(env.DB), ctx.installationId);
    const rows = await dayRows(ctx.installationId, "no-concurrency");
    expect(sum(rows)).toEqual({ count: 1, minutes: 40 });
    expect(rows[0]).toMatchObject({
      subject: "CI",
      workflowPath: ".github/workflows/ci.yml",
      repositoryFullName: "acme/app",
    });
    // 40 ubuntu-latest minutes in a private repo.
    expect(rows.reduce((total, row) => total + row.cost, 0)).toBeCloseTo(0.24);
  });

  test("counts the push run of a commit that also ran from a pull request", async () => {
    const ctx = await connectedWorkspace();
    await runWithJob(ctx, {
      start: 60,
      minutes: 10,
      event: "push",
      headSha: "same",
      headBranch: "a",
    });
    await runWithJob(ctx, { start: 58, minutes: 12, headSha: "same", headBranch: "a" });
    // Another workflow on the same commit isn't a repeat.
    await runWithJob(ctx, {
      start: 600,
      minutes: 10,
      event: "push",
      headSha: "solo",
      headBranch: "b",
      workflowName: "Deploy",
      workflowId: 8,
    });
    await runWithJob(ctx, { start: 590, minutes: 10, headSha: "solo", headBranch: "b" });

    await rollUpSignals(createDb(env.DB), ctx.installationId);
    expect(sum(await dayRows(ctx.installationId, "same-commit"))).toEqual({
      count: 1,
      minutes: 10,
    });
  });

  test("counts the unused part of short jobs on billed runners, and not in public repos", async () => {
    const paid = await connectedWorkspace();
    await shortJobs(paid, 4);
    await rollUpSignals(createDb(env.DB), paid.installationId);
    const rows = await dayRows(paid.installationId, "short-jobs");
    // Four 15-second jobs each pay for 45 seconds they didn't use.
    expect(sum(rows)).toEqual({ count: 4, minutes: 3 });
    expect(rows[0]?.subject).toBe("Lint › lint");

    const free = await connectedWorkspace({ isPrivate: false });
    await shortJobs(free, 4);
    await rollUpSignals(createDb(env.DB), free.installationId);
    expect(await dayRows(free.installationId, "short-jobs")).toEqual([]);
    expect(sum(await dayRows(free.installationId, "total")).count).toBe(4);
  });

  test("counts jobs that waited over a minute for a runner, picks left out", async () => {
    const ctx = await connectedWorkspace();
    await job(ctx, { start: 30, minutes: 2, waited: 5 });
    await job(ctx, { start: 20, minutes: 2, waited: 0.5 });
    await job(ctx, { start: 10, minutes: 1, waited: 8, labels: ["relayrunner"] });
    await rollUpSignals(createDb(env.DB), ctx.installationId);
    const rows = await dayRows(ctx.installationId, "queue-waits");
    expect(sum(rows)).toEqual({ count: 1, minutes: 5 });
    expect(rows[0]).toMatchObject({ subject: "ubuntu-latest", cost: 0 });
    // Summed per whole UTC day.
    expect(rows[0]!.day.getTime() % (24 * 60 * MINUTE)).toBe(0);
  });

  test("counts the time a run kept going on one job after the jobs beside it finished", async () => {
    const ctx = await connectedWorkspace();
    // Side by side: e2e runs 6 minutes past lint.
    await job(ctx, { start: 60, minutes: 10, runId: 1, name: "e2e" });
    await job(ctx, { start: 60, minutes: 4, runId: 1, name: "lint" });
    // Deploy needs build, so it starts after build finished: not counted.
    await job(ctx, { start: 120, minutes: 3, runId: 2, name: "build" });
    await job(ctx, { start: 117, minutes: 5, runId: 2, name: "deploy" });
    await rollUpSignals(createDb(env.DB), ctx.installationId);
    const rows = await dayRows(ctx.installationId, "slowest-job");
    expect(sum(rows)).toEqual({ count: 1, minutes: 6 });
    expect(rows[0]?.subject).toBe("CI › e2e");
  });

  test("counts failed jobs that passed on the next attempt, with the failed attempt's time", async () => {
    const ctx = await connectedWorkspace();
    await job(ctx, { start: 60, minutes: 5, runId: 3, conclusion: "failure" });
    await rerun(ctx, 3, 2, 50);
    await job(ctx, { start: 50, minutes: 5, runId: 3, runAttempt: 2 });
    // Failed on the re-run too: not flaky.
    await job(ctx, { start: 40, minutes: 5, runId: 4, conclusion: "failure" });
    await rerun(ctx, 4, 2, 30);
    await job(ctx, { start: 30, minutes: 5, runId: 4, runAttempt: 2, conclusion: "failure" });
    await rollUpSignals(createDb(env.DB), ctx.installationId);
    const rows = await dayRows(ctx.installationId, "flaky-jobs");
    expect(sum(rows)).toEqual({ count: 1, minutes: 5 });
    // 5 ubuntu-latest minutes in a private repo.
    expect(rows[0]?.cost).toBeCloseTo(0.03);
    expect(rows[0]?.workflowPath).toBe(".github/workflows/ci.yml");
  });

  test("counts jobs their runner failed before any step as runner failures, not flaky", async () => {
    const ctx = await connectedWorkspace();
    await job(ctx, { start: 60, minutes: 1, runId: 5, conclusion: "failure", ranSteps: false });
    await rerun(ctx, 5, 2, 50);
    await job(ctx, { start: 50, minutes: 5, runId: 5, runAttempt: 2 });
    // Failed in a step: neither a runner failure nor (without a passing re-run) flaky.
    await job(ctx, { start: 40, minutes: 3, conclusion: "failure", ranSteps: true });
    await rollUpSignals(createDb(env.DB), ctx.installationId);
    expect(await dayRows(ctx.installationId, "flaky-jobs")).toEqual([]);
    const rows = await dayRows(ctx.installationId, "runner-failures");
    expect(sum(rows)).toEqual({ count: 1, minutes: 1 });
    expect(rows[0]?.subject).toBe("ubuntu-latest");
  });

  test("counts runs for docs-titled changes, except docs workflows", async () => {
    const ctx = await connectedWorkspace();
    await runWithJob(ctx, { start: 60, minutes: 8, displayTitle: "docs: fix a typo" });
    await runWithJob(ctx, {
      start: 50,
      minutes: 3,
      displayTitle: "docs(site): fix a typo",
      workflowName: "Docs",
    });
    await runWithJob(ctx, { start: 40, minutes: 6, displayTitle: "feat: add a page" });
    await rollUpSignals(createDb(env.DB), ctx.installationId);
    const rows = await dayRows(ctx.installationId, "docs-changes");
    expect(sum(rows)).toEqual({ count: 1, minutes: 8 });
    expect(rows[0]?.subject).toBe("CI");
  });

  test("counts branch runs that start ten or more jobs", async () => {
    const ctx = await connectedWorkspace();
    const wide = await runWithJob(ctx, { start: 60, minutes: 2 });
    for (let i = 1; i < 10; i += 1) {
      await job(ctx, { start: 60, minutes: 2, runId: wide, name: `test (${i})` });
    }
    // Nine jobs on a branch, and ten on the default branch: neither counts.
    const narrow = await runWithJob(ctx, { start: 40, minutes: 2 });
    for (let i = 1; i < 9; i += 1) {
      await job(ctx, { start: 40, minutes: 2, runId: narrow, name: `test (${i})` });
    }
    const main = await runWithJob(ctx, {
      start: 20,
      minutes: 2,
      headBranch: "main",
      event: "push",
    });
    for (let i = 1; i < 10; i += 1) {
      await job(ctx, { start: 20, minutes: 2, runId: main, name: `test (${i})` });
    }
    await rollUpSignals(createDb(env.DB), ctx.installationId);
    expect(sum(await dayRows(ctx.installationId, "wide-fanout"))).toEqual({
      count: 1,
      minutes: 20,
    });
  });

  test("splits every job by who started its run, workflow, branch and trigger", async () => {
    const ctx = await connectedWorkspace();
    const first = await runWithJob(ctx, {
      start: 60,
      minutes: 4,
      startedByLogin: "ana",
      event: "push",
    });
    await job(ctx, { start: 60, minutes: 6, runId: first, name: "build" });
    await runWithJob(ctx, { start: 40, minutes: 3, actorLogin: "sam", headBranch: "main" });
    // Jobs whose run we never saw share the empty subject.
    await shortJobs(ctx, 2);
    await rollUpSignals(createDb(env.DB), ctx.installationId);

    const by = async (view: string) =>
      Object.fromEntries(
        (await dayRows(ctx.installationId, `by-${view}`)).map((row) => [
          row.subject,
          { runs: row.count, minutes: row.runMs / MINUTE },
        ]),
      );
    expect(await by("person")).toEqual({
      ana: { runs: 1, minutes: 10 },
      sam: { runs: 1, minutes: 3 },
      "": { runs: 2, minutes: 0.5 },
    });
    expect(await by("trigger")).toEqual({
      push: { runs: 1, minutes: 10 },
      pull_request: { runs: 1, minutes: 3 },
      "": { runs: 2, minutes: 0.5 },
    });
    expect(await by("branch")).toMatchObject({ feature: { runs: 1 }, main: { runs: 1 } });
    // Workflows fall back to the job's own workflow name.
    expect(await by("workflow")).toMatchObject({ CI: { runs: 2 }, Lint: { runs: 2 } });
  });

  test("counts a re-run as its own trigger", async () => {
    const ctx = await connectedWorkspace();
    const id = await runWithJob(ctx, { start: 60, minutes: 2 });
    await rerun(ctx, id, 2, 50);
    await job(ctx, { start: 50, minutes: 2, runId: id, runAttempt: 2 });
    await rollUpSignals(createDb(env.DB), ctx.installationId);
    const rows = await dayRows(ctx.installationId, "by-trigger");
    expect(rows.map((row) => [row.subject, row.count]).sort()).toEqual([
      ["pull_request", 1],
      ["rerun", 1],
    ]);
  });

  test("replaces the days it works out, so running twice counts once", async () => {
    const ctx = await connectedWorkspace();
    await shortJobs(ctx, 2);
    const db = createDb(env.DB);
    await rollUpSignals(db, ctx.installationId);
    await rollUpSignals(db, ctx.installationId);
    expect(sum(await dayRows(ctx.installationId, "total")).count).toBe(2);
  });
});

describe("enqueueSignalRollups", () => {
  test("queues installations that finished a job in the last two hours", async () => {
    const active = await connectedWorkspace();
    await shortJobs(active, 1);
    const idle = await connectedWorkspace();
    const queued: InstallationTask[] = [];
    const queue = {
      sendBatch: async (messages: { body: InstallationTask }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    } as unknown as Queue<InstallationTask>;
    await enqueueSignalRollups({ ...env, INSTALLATION_TASKS: queue }, NOW);
    expect(queued).toContainEqual({ kind: "signals", installationId: active.installationId });
    expect(queued).not.toContainEqual({ kind: "signals", installationId: idle.installationId });
  });
});

describe("GET /api/signals", () => {
  test("lists signals over the threshold with their rows, the most time first", async () => {
    const ctx = await connectedWorkspace();
    await runWithJob(ctx, { start: 300, minutes: 120 });
    await runWithJob(ctx, { start: 280, minutes: 20 });
    // 3 short jobs: well under the 30-minute floor, so not listed.
    await shortJobs(ctx, 3);
    await rollUpSignals(createDb(env.DB), ctx.installationId);

    const body = await report(ctx.cookie);
    expect(body.days).toBe(7);
    expect(body.totals.jobs).toBe(5);
    expect(body.signals.map((signal) => signal.id)).toEqual(["no-concurrency"]);
    expect(body.signals[0]).toMatchObject({
      area: "cost",
      count: 1,
      minutes: 100,
      rows: [{ repository: "acme/app", subject: "CI", count: 1, minutes: 100 }],
    });
  });

  test("breaks down every job, summing repos from the workflow view", async () => {
    const ctx = await connectedWorkspace();
    await runWithJob(ctx, { start: 60, minutes: 30, startedByLogin: "ana" });
    await runWithJob(ctx, { start: 40, minutes: 10, startedByLogin: "sam" });
    await shortJobs(ctx, 2);
    await rollUpSignals(createDb(env.DB), ctx.installationId);

    const { breakdown } = await report(ctx.cookie);
    expect(breakdown.person).toMatchObject({
      rows: [
        { name: "ana", repository: null, runs: 1, minutes: 30 },
        { name: "sam", runs: 1, minutes: 10 },
      ],
      other: { runs: 2 },
    });
    expect(breakdown.repository).toMatchObject({
      rows: [{ name: "acme/app", runs: 4, minutes: 41 }],
      other: null,
    });
    expect(breakdown.workflow.rows[0]).toMatchObject({
      name: "CI",
      repository: "acme/app",
      workflowPath: ".github/workflows/ci.yml",
      runs: 2,
    });
  });

  test("is empty before the first rollup", async () => {
    const ctx = await connectedWorkspace();
    const empty = { rows: [], other: null };
    expect(await report(ctx.cookie)).toEqual({
      days: 7,
      totals: { jobs: 0, minutes: 0, cost: 0 },
      signals: [],
      breakdown: {
        person: empty,
        workflow: empty,
        branch: empty,
        trigger: empty,
        repository: empty,
      },
    });
  });
});
