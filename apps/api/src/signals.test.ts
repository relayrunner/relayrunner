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
    // 40 Linux 2-core minutes in a private repo.
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

  test("is empty before the first rollup", async () => {
    const ctx = await connectedWorkspace();
    expect(await report(ctx.cookie)).toEqual({
      days: 7,
      totals: { jobs: 0, minutes: 0, cost: 0 },
      signals: [],
    });
  });
});
