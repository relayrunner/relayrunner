import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDb, type Db, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { evaluationWorkflows } from "../reports/evaluations.ts";
import {
  importRunHistory,
  queueRunHistory,
  runHistoryRow,
  runHistoryState,
  withGitHubWorkflows,
} from "./run-history.ts";
import * as testing from "../testing.ts";

vi.mock("../github/github-app.ts", async (original) => ({
  ...(await original<typeof import("../github/github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
}));

let env: Env;
let db: Db;
const NOW = Date.parse("2026-11-23T12:00:00Z");

beforeEach(async () => {
  env = await testing.createTestEnv();
  db = createDb(env.DB);
  for (const statement of [
    "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (8, 11, 'acme', 'Organization', ?1, ?1)",
    "insert into workspace (id, installation_id, name, slug, created_at) values ('w1', 8, 'W1', 'w1', ?1)",
    "insert into github_repository (id, installation_id, full_name, private, github_state_at, created_at, updated_at) values (5, 8, 'acme/web', 1, ?1, ?1, ?1)",
  ])
    await env.DB.prepare(statement).bind(NOW).run();
});

afterEach(() => vi.unstubAllGlobals());

const at = (hoursAgo: number, minutes = 0) =>
  new Date(NOW - hoursAgo * 3_600_000 + minutes * 60_000).toISOString();

function run(id: number, rest: Record<string, unknown> = {}) {
  return {
    id,
    run_attempt: 1,
    name: "CI",
    workflow_id: 1,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: `sha${id}`,
    status: "completed",
    conclusion: "success",
    run_started_at: at(id),
    updated_at: at(id, 10),
    ...rest,
  };
}

function job(id: number, runId: number) {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    name: "test",
    workflow_name: "CI",
    status: "completed",
    conclusion: "success",
    labels: ["ubuntu-latest"],
    head_sha: `sha${runId}`,
    runner_name: "GitHub Actions 1",
    runner_group_name: "GitHub Actions",
    created_at: at(runId),
    started_at: at(runId),
    completed_at: at(runId, 8),
    steps: [],
  };
}

function github(runs: unknown[]) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/actions/runs?")) return Response.json({ workflow_runs: runs });
    const jobs = url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/);
    if (jobs) return Response.json({ jobs: [job(Number(jobs[1]) * 10, Number(jobs[1]))] });
    if (url.endsWith("/repos/acme/web")) return Response.json({ default_branch: "main" });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

test("a new installation queues one import", async () => {
  const sent: unknown[] = [];
  const queued = {
    ...env,
    INSTALLATION_TASKS: { sendBatch: async (messages: unknown[]) => void sent.push(...messages) },
  } as unknown as Env;
  await queueRunHistory(queued, db, 8);
  await queueRunHistory(queued, db, 8);
  expect(sent).toEqual([{ body: { kind: "run-history", installationId: 8 } }]);
  expect(await runHistoryState(db, 8)).toEqual({ state: "queued", runs: 0 });
});

test("an installation from before imports has no state", async () => {
  expect(await runHistoryState(db, 8)).toBeNull();
});

test("imports runs, and the jobs of each workflow's baseline runs", async () => {
  await db.insert(schema.runHistoryImport).values({ installationId: 8, state: "queued" });
  const calls = github([
    run(1),
    run(2),
    // Not part of a baseline: another branch, a failure, a dispatch.
    run(3, { head_branch: "feature" }),
    run(4, { conclusion: "failure" }),
    run(5, { event: "workflow_dispatch" }),
  ]);
  await importRunHistory(env, 8, NOW);

  expect(await runHistoryState(db, 8)).toEqual({ state: "done", runs: 5 });
  expect(calls.some((url) => url.includes("created=%3E%3D2026-11-09"))).toBe(true);
  const jobReads = calls.filter((url) => url.includes("/jobs")).map((url) => url.split("/")[8]);
  expect(jobReads.sort()).toEqual(["1", "2"]);

  const [workflow] = await evaluationWorkflows(db, "w1", NOW);
  expect(workflow).toMatchObject({
    repository: "acme/web",
    path: ".github/workflows/ci.yml",
    runs: 5,
    baselineRuns: 2,
    medianMs: 8 * 60_000,
  });
});

test("leaves rows a webhook already wrote", async () => {
  await db.insert(schema.runHistoryImport).values({ installationId: 8, state: "queued" });
  await env.DB.prepare(
    "insert into workflow_run (id, run_attempt, installation_id, repository_id, repository_full_name, event, head_sha, status, conclusion, github_updated_at, created_at, updated_at) values (1, 1, 8, 5, 'acme/web', 'push', 'sha1', 'completed', 'cancelled', ?1, ?1, ?1)",
  )
    .bind(NOW)
    .run();
  github([run(1)]);
  await importRunHistory(env, 8, NOW);
  const stored = await env.DB.prepare("select conclusion from workflow_run where id = 1").first();
  expect(stored?.conclusion).toBe("cancelled");
});

test("a GitHub failure is recorded, not thrown", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await db.insert(schema.runHistoryImport).values({ installationId: 8, state: "queued" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("boom", { status: 500 })),
  );
  await importRunHistory(env, 8, NOW);
  const row = await runHistoryRow(db, 8);
  expect(row?.state).toBe("failed");
  expect(row?.error).toContain("500");
});

test("while importing, the workflow list adds the workflows GitHub lists", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/actions/workflows")
        ? Response.json({
            total_count: 3,
            workflows: [
              { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
              { id: 2, name: "E2E", path: ".github/workflows/e2e.yml", state: "active" },
              { id: 3, name: "Old", path: ".github/workflows/old.yml", state: "disabled_manually" },
            ],
          })
        : new Response("not found", { status: 404 }),
    ),
  );
  const known = {
    repositoryId: 5,
    repository: "acme/web",
    workflow: "CI",
    path: ".github/workflows/ci.yml",
    runs: 4,
    baselineRuns: 2,
    medianMs: 60_000,
    relayed: false,
    dispatched: false,
  };
  const list = await withGitHubWorkflows(env, db, 8, [known]);
  expect(list.map((w) => [w.path, w.runs, w.relayed])).toEqual([
    // No relay seen in a few imported runs isn't known yet either.
    [".github/workflows/ci.yml", 4, null],
    [".github/workflows/e2e.yml", 0, null],
  ]);
});
