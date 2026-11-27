import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import {
  advanceEvaluation,
  evaluationReport,
  evaluationRunner,
  evaluationWorkflows,
  isEvaluable,
  recentEvaluations,
  resumeWaitingEvaluations,
  startEvaluation,
  median,
} from "./evaluations.ts";
import * as testing from "../testing.ts";

vi.mock("../github/github-app.ts", async (original) => ({
  ...(await original<typeof import("../github/github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));

let env: Env;
let db: Db;
const bot = { id: 1, login: "relayrunner[bot]" };
const person = { id: 2, login: "ada" };

beforeEach(async () => {
  env = await testing.createTestEnv();
  db = createDb(env.DB);
  const now = Date.now();
  for (const statement of [
    "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (8, 11, 'acme', 'Organization', ?1, ?1)",
    "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 8, 'W1', 'w1', ?1)",
  ])
    await env.DB.prepare(statement).bind(now).run();
});

afterEach(() => vi.unstubAllGlobals());

async function evaluation(rest: Partial<typeof schema.evaluation.$inferInsert> = {}) {
  await db.insert(schema.evaluation).values({
    id: "e1",
    workspaceId: "w1",
    installationId: 8,
    repositoryId: 5,
    repositoryFullName: "acme/web",
    workflowPath: ".github/workflows/ci.yml",
    workflowName: "CI",
    provider: "namespace",
    vcpus: 4,
    label: "nscloud-ubuntu-24.04-amd64-4x16",
    ref: "main",
    runs: 5,
    runId: 100,
    state: "running",
    ...rest,
  });
}

const context = (runId: number, startedBy = person) => ({
  runId,
  workflowPath: ".github/workflows/ci.yml",
  startedBy,
});

test("only hosted providers with sized labels can be evaluated", () => {
  expect(isEvaluable("namespace")).toBe(true);
  expect(isEvaluable("blacksmith")).toBe(true);
  expect(isEvaluable("runs-on")).toBe(false);
  expect(isEvaluable("github")).toBe(false);
});

test("an evaluation's run goes to its label", async () => {
  await evaluation();
  expect(await evaluationRunner(db, 5, context(100, bot))).toEqual({
    evaluationId: "e1",
    provider: "namespace",
    label: "nscloud-ubuntu-24.04-amd64-4x16",
  });
});

test("other runs, and finished evaluations, walk the runner order", async () => {
  await evaluation({ state: "done" });
  const sleep = vi.fn(async () => undefined);
  expect(await evaluationRunner(db, 5, context(100, bot), { sleep })).toBeNull();
  // A concurrent CI run of the same workflow is never the evaluation's.
  expect(await evaluationRunner(db, 5, context(101), { sleep })).toBeNull();
  expect(sleep).not.toHaveBeenCalled();
});

test("a dispatched run waits for its evaluation's run id", async () => {
  await evaluation({ runId: null, state: "dispatching" });
  let polls = 0;
  const sleep = vi.fn(async () => {
    polls += 1;
    if (polls === 2)
      await db
        .update(schema.evaluation)
        .set({ runId: 100, state: "running" })
        .where(eq(schema.evaluation.id, "e1"));
  });
  const pick = await evaluationRunner(db, 5, context(100, bot), { sleep, pollMs: 0 });
  expect(pick?.label).toBe("nscloud-ubuntu-24.04-amd64-4x16");
  expect(sleep).toHaveBeenCalledTimes(2);
});

test("only an App's run waits, and not past the deadline", async () => {
  await evaluation({ runId: null, state: "dispatching" });
  const sleep = vi.fn(async () => undefined);
  // A person's run of the same workflow doesn't wait.
  expect(await evaluationRunner(db, 5, context(101), { sleep })).toBeNull();
  expect(sleep).not.toHaveBeenCalled();
  expect(await evaluationRunner(db, 5, context(101, bot), { sleep, waitMs: 0 })).toBeNull();
});

const completed = (runAttempt: number, conclusion = "success") =>
  ({
    event: "workflow_run",
    deliveryId: "d",
    action: "completed",
    installationId: 8,
    receivedAt: new Date().toISOString(),
    repository: { id: 5, fullName: "acme/web" },
    run: { id: 100, runAttempt, conclusion },
  }) as unknown as Extract<WebhookMessage, { event: "workflow_run" }>;

const state = () => db.select().from(schema.evaluation).where(eq(schema.evaluation.id, "e1")).get();

test("a finished attempt re-runs the run once, even when the event comes twice", async () => {
  await evaluation();
  const fetch = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetch);
  await advanceEvaluation(env, db, completed(1));
  await advanceEvaluation(env, db, completed(1));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain(
    "/repos/acme/web/actions/runs/100/rerun",
  );
  expect((await state())?.attempt).toBe(2);
});

test("the last attempt finishes it, and a failed one ends it", async () => {
  await evaluation({ attempt: 5 });
  vi.stubGlobal("fetch", vi.fn());
  await advanceEvaluation(env, db, completed(5));
  expect((await state())?.state).toBe("done");

  await db.delete(schema.evaluation);
  await evaluation({ attempt: 2 });
  await advanceEvaluation(env, db, completed(2, "failure"));
  expect(await state()).toMatchObject({
    state: "failed",
    error: "Run 2 failed.",
  });
});

test("a failed attempt's error names the job and the step it failed at", async () => {
  await evaluation();
  vi.stubGlobal("fetch", vi.fn());
  const job = (id: number, name: string, conclusion: string, failedStep: string | null) =>
    db.insert(schema.jobTiming).values({
      id,
      installationId: 8,
      repositoryId: 5,
      repositoryFullName: "acme/web",
      runId: 100,
      runAttempt: 1,
      workflowName: "CI",
      name,
      labels: ["boat"],
      conclusion,
      failedStep,
      completedAt: new Date(id * 1000),
    });
  await job(1, "lint", "success", null);
  await job(2, "test", "failure", "2. Set up runner");
  await job(3, "build", "failure", null);
  await advanceEvaluation(env, db, completed(1, "failure"));
  expect((await state())?.error).toBe("Run 1 failed: test (and 1 more) failed at Set up runner.");
});

test("a failed attempt isn't compared, and its jobs say where they failed", async () => {
  const at = Date.now() - 60 * 60_000;
  await evaluation({ state: "failed", createdAt: new Date(at) });
  await db.insert(schema.jobTiming).values({
    id: 7,
    installationId: 8,
    repositoryId: 5,
    repositoryFullName: "acme/web",
    runId: 100,
    runAttempt: 1,
    workflowName: "CI",
    name: "test",
    labels: ["nscloud-ubuntu-24.04-amd64-4x16"],
    conclusion: "failure",
    failedStep: "2. Set up runner",
    queuedAt: new Date(at),
    startedAt: new Date(at),
    completedAt: new Date(at + 6_000),
  });
  const report = await evaluationReport(db, "w1", "e1");
  expect(report.attempts[0]).toMatchObject({
    status: "done",
    conclusion: "failure",
  });
  expect(report.attempts[0]?.jobs[0]).toMatchObject({
    id: 7,
    failedStep: "2. Set up runner",
  });
  expect(report.cold.ms).toBeNull();
  expect(report.jobs[0]?.cold).toBeNull();
});

test("compares runs with the workflow's recent passing runs", async () => {
  const at = Date.now() - 60 * 60_000;
  await evaluation({ attempt: 2, createdAt: new Date(at) });
  const run = (id: number, event: string, minutesAgo: number) =>
    db.insert(schema.workflowRun).values({
      id,
      runAttempt: 1,
      installationId: 8,
      repositoryId: 5,
      repositoryFullName: "acme/web",
      workflowName: "CI",
      workflowPath: ".github/workflows/ci.yml",
      defaultBranch: "main",
      headBranch: "main",
      headSha: "abc",
      event,
      status: "completed",
      conclusion: "success",
      runStartedAt: new Date(at - minutesAgo * 60_000),
      githubUpdatedAt: new Date(at),
    });
  let jobId = 1;
  const job = (
    runId: number,
    runAttempt: number,
    name: string,
    start: number,
    wait: number,
    run: number,
    labels = ["ubuntu-latest"],
  ) =>
    db.insert(schema.jobTiming).values({
      id: jobId++,
      installationId: 8,
      repositoryId: 5,
      repositoryFullName: "acme/web",
      runId,
      runAttempt,
      workflowName: "CI",
      name,
      labels,
      conclusion: "success",
      queuedAt: new Date(start),
      startedAt: new Date(start + wait),
      completedAt: new Date(start + wait + run),
    });
  await run(1, "push", 120);
  await run(2, "push", 90);
  await run(3, "workflow_dispatch", 80); // Left out of the baseline.
  await job(1, 1, "test", at - 120 * 60_000, 10_000, 100_000);
  await job(2, 1, "test", at - 90 * 60_000, 20_000, 120_000);
  await job(3, 1, "test", at - 80 * 60_000, 0, 1_000);
  const ns = ["nscloud-ubuntu-24.04-amd64-4x16"];
  await job(100, 1, "relay", at, 0, 1_000, ["relayrunner"]);
  await job(100, 1, "test", at, 5_000, 80_000, ns);
  await job(100, 2, "test", at + 200_000, 2_000, 40_000, ns);

  const report = await evaluationReport(db, "w1", "e1");
  // Two minutes each on ubuntu-latest in a private repo; the relay pick is free.
  expect(report.baseline).toEqual({ runs: 2, medianMs: 125_000, waitMs: 15_000, usd: 0.012 });
  expect(report.attempts.map((a) => a.status)).toEqual([
    "done",
    "running",
    "waiting",
    "waiting",
    "waiting",
  ]);
  // Namespace has no list price: its plan's 2 vCPU minute ($0.006) scaled to 4 vCPU, two minutes.
  expect(report.cold).toEqual({ ms: 85_000, waitMs: 5_000, usd: 0.024 });
  expect(report.attempts.map((a) => a.usd)).toEqual([0.024, null, null, null, null]);
  expect(report.jobs).toEqual([
    {
      name: "test",
      baseline: { waitMs: 15_000, runMs: 110_000 },
      cold: { waitMs: 5_000, runMs: 80_000 },
      warm: null,
      onProvider: true,
    },
  ]);
});

test("a stopped evaluation compares the runs that finished, not the one it cancelled", async () => {
  const at = Date.now() - 60 * 60_000;
  await evaluation({ attempt: 3, state: "cancelled", createdAt: new Date(at) });
  const ns = ["nscloud-ubuntu-24.04-amd64-4x16"];
  let id = 1;
  const job = (runAttempt: number, start: number, run: number, conclusion = "success") =>
    db.insert(schema.jobTiming).values({
      id: id++,
      installationId: 8,
      repositoryId: 5,
      repositoryFullName: "acme/web",
      runId: 100,
      runAttempt,
      workflowName: "CI",
      name: "test",
      labels: ns,
      conclusion,
      queuedAt: new Date(start),
      startedAt: new Date(start),
      completedAt: new Date(start + run),
    });
  await job(1, at, 80_000);
  await job(2, at + 100_000, 40_000);
  await job(3, at + 200_000, 5_000, "cancelled");

  const report = await evaluationReport(db, "w1", "e1");
  expect(report.attempts.map((a) => a.status)).toEqual([
    "done",
    "done",
    "waiting",
    "waiting",
    "waiting",
  ]);
  expect(report.cold.ms).toBe(80_000);
  expect(report.warm.ms).toBe(40_000);
  expect(report.jobs[0]?.warm).toEqual({ waitMs: 0, runMs: 40_000 });
});

test("recent evaluations: the last 30 days and any still going, with runs on the provider since", async () => {
  const now = Date.now();
  const day = 86_400_000;
  await evaluation({ state: "done", createdAt: new Date(now - 2 * day) });
  await evaluation({ id: "old", runId: 101, state: "done", createdAt: new Date(now - 40 * day) });
  await evaluation({
    id: "going",
    runId: 102,
    state: "running",
    createdAt: new Date(now - 40 * day),
  });
  await evaluation({ id: "other", runId: 103, provider: "blacksmith", createdAt: new Date(now) });
  const ns = ["nscloud-ubuntu-24.04-amd64-4x16"];
  let id = 1;
  const job = (runId: number, start: number, labels = ns) =>
    db.insert(schema.jobTiming).values({
      id: id++,
      installationId: 8,
      repositoryId: 5,
      repositoryFullName: "acme/web",
      runId,
      runAttempt: 1,
      workflowName: "CI",
      name: "test",
      labels,
      conclusion: "success",
      queuedAt: new Date(start),
      startedAt: new Date(start),
      completedAt: new Date(start + 60_000),
    });
  await job(100, now - 2 * day + 1000); // The evaluation's own run.
  await job(200, now - day); // Routed CI on Namespace since: counts.
  await job(201, now - day, ["ubuntu-latest"]); // On GitHub: doesn't.
  await job(202, now - 3 * day); // Before the evaluation: doesn't.

  const recent = await recentEvaluations(db, "w1", "namespace", now);
  expect(recent.map((e) => e.id)).toEqual(["e1", "going"]);
  expect(recent[0]).toMatchObject({ finished: 1, ms: 60_000, routedRuns: 1, state: "done" });
});

test("median", () => {
  expect(median([])).toBeNull();
  expect(median([3, 1, 2])).toBe(2);
  expect(median([1, 2, 3, 4])).toBe(3);
});

function github(dispatch: Response) {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/dispatches")) return dispatch;
    if (path.endsWith("/repos/acme/web")) return Response.json({ default_branch: "main" });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const start = {
  workspaceId: "w1",
  installationId: 8,
  userId: null,
  repositoryId: 5,
  workflowPath: ".github/workflows/ci.yml",
  provider: "namespace",
  vcpus: 4,
};

async function repo() {
  const now = Date.now();
  await env.DB.prepare(
    "insert into github_repository (id, installation_id, full_name, private, github_state_at, created_at, updated_at) values (5, 8, 'acme/web', 1, ?1, ?1, ?1)",
  )
    .bind(now)
    .run();
}

test("starting dispatches the workflow on the default branch and keeps its run", async () => {
  await repo();
  const fetch = github(Response.json({ workflow_run_id: 321 }));
  const id = await startEvaluation(env, db, start);
  const row = await db.select().from(schema.evaluation).where(eq(schema.evaluation.id, id)).get();
  expect(row).toMatchObject({
    state: "running",
    runId: 321,
    ref: "main",
    label: "nscloud-ubuntu-24.04-amd64-4x16",
  });
  const dispatch = fetch.mock.calls.find(([url]) => String(url).endsWith("/dispatches"))!;
  expect(String(dispatch[0])).toContain("/repos/acme/web/actions/workflows/ci.yml/dispatches");
  // One at a time per workflow.
  await expect(startEvaluation(env, db, start)).rejects.toMatchObject({
    code: "EVALUATION_ACTIVE",
  });
});

test("a workflow without workflow_dispatch waits, and a push that runs it tries again", async () => {
  await repo();
  github(
    Response.json(
      { message: "Workflow does not have 'workflow_dispatch' trigger" },
      { status: 422 },
    ),
  );
  const id = await startEvaluation(env, db, start);
  expect(await db.select().from(schema.evaluation).get()).toMatchObject({
    state: "waiting",
    error: "no_dispatch",
  });
  // A pull request's run, or another branch's push, doesn't count.
  const push = (headBranch: string, event = "push") =>
    ({
      event: "workflow_run",
      action: "requested",
      repository: { id: 5, fullName: "acme/web" },
      run: { id: 9, runAttempt: 1, event, headBranch, workflowPath: ".github/workflows/ci.yml" },
    }) as unknown as Extract<WebhookMessage, { event: "workflow_run" }>;
  const fetch = github(Response.json({ workflow_run_id: 555 }));
  await resumeWaitingEvaluations(env, db, push("main", "pull_request"));
  await resumeWaitingEvaluations(env, db, push("feature"));
  expect(fetch).not.toHaveBeenCalled();
  await resumeWaitingEvaluations(env, db, push("main"));
  expect(
    await db.select().from(schema.evaluation).where(eq(schema.evaluation.id, id)).get(),
  ).toMatchObject({
    state: "running",
    runId: 555,
    error: null,
  });
});

test("lists recent workflows with whether they relay and were dispatched", async () => {
  const now = Date.now();
  await db.insert(schema.workflowRun).values({
    id: 7,
    runAttempt: 1,
    installationId: 8,
    repositoryId: 5,
    repositoryFullName: "acme/web",
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    defaultBranch: "main",
    headBranch: "main",
    headSha: "abc",
    event: "push",
    status: "completed",
    conclusion: "success",
    runStartedAt: new Date(now - 60_000),
    githubUpdatedAt: new Date(now),
  });
  await db.insert(schema.jobTiming).values({
    id: 1,
    installationId: 8,
    repositoryId: 5,
    repositoryFullName: "acme/web",
    runId: 7,
    runAttempt: 1,
    name: "relay",
    labels: ["relayrunner"],
    queuedAt: new Date(now - 60_000),
    startedAt: new Date(now - 59_000),
    completedAt: new Date(now - 58_000),
  });
  expect(await evaluationWorkflows(db, "w1", now)).toEqual([
    {
      repositoryId: 5,
      repository: "acme/web",
      workflow: "CI",
      path: ".github/workflows/ci.yml",
      runs: 1,
      baselineRuns: 1,
      medianMs: 2_000,
      relayed: true,
      dispatched: false,
    },
  ]);
});
