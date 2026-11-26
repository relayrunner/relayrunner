import { DAY_MS } from "../time.ts";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { jobTypeTimes } from "./job-type-times.ts";
import { jobRuns } from "./job-times.ts";
import { lastDays, withPrior } from "./report-window.ts";
import type { StepTime } from "./step-phases.ts";
import * as testing from "../testing.ts";

let env: Env;
let workspaceId: string;
let installationId: number;
let ids = 0;

// Noon UTC, so days ago and local midnights fall where the tests expect.
const NOW = Date.UTC(2026, 10, 20, 12);
const last = (days: number) => withPrior(lastDays(days, NOW));

async function job(
  name: string,
  completedAt: number,
  runMs: number,
  labels = ["ubuntu-latest"],
  steps: StepTime[] | null = null,
) {
  ids += 1;
  await createDb(env.DB)
    .insert(schema.jobTiming)
    .values({
      id: ids,
      installationId,
      repositoryId: 77,
      repositoryFullName: "acme/app",
      runId: ids,
      runAttempt: 1,
      workflowName: "CI",
      name,
      labels,
      conclusion: "success",
      runnerName: "runner",
      runnerGroupName: "GitHub Actions",
      startedAt: new Date(completedAt - runMs),
      completedAt: new Date(completedAt),
      steps,
    });
}

async function type(job: string, kind: string, confidence = 0.9) {
  await createDb(env.DB)
    .insert(schema.jobType)
    .values({
      workspaceId,
      repositoryId: 77,
      workflow: "CI",
      job,
      kind,
      confidence,
      classifiedAt: new Date(NOW),
    });
}

beforeEach(async () => {
  env = await testing.createTestEnv();
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, "Acme", "acme");
  workspaceId = workspace.id;
  installationId = workspace.installationId;
});

describe("jobTypeTimes", () => {
  test("adds run time per job and day, matrix legs together, with each job's type", async () => {
    await type("test", "test");
    await type("misc", "other", 0.5);
    await job("test (node 22)", NOW - 60_000, 120_000);
    await job("test (node 24)", NOW - DAY_MS, 60_000);
    await job("lint", NOW - 2 * DAY_MS, 30_000);
    await job("misc", NOW - 60_000, 10_000);
    // A pick only routes its run: left out.
    await job("relay / RelayRunner", NOW - 60_000, 5_000, ["relayrunner"]);
    // Before the window: only counts toward the change.
    await job("test (node 22)", NOW - 9 * DAY_MS, 90_000);

    const report = await jobTypeTimes(createDb(env.DB), workspaceId, last(7), { now: NOW });
    expect(report.compare).toBe(true);
    expect(report.start).toBe(Date.UTC(2026, 10, 14));
    expect(report.jobs.map((j) => [j.job, j.type, j.runs, j.ms, j.priorMs])).toEqual([
      ["test", "test", 2, 180_000, 90_000],
      ["lint", null, 1, 30_000, 0],
      // Too unsure to show.
      ["misc", null, 1, 10_000, 0],
    ]);
    expect(report.jobs[0]!.byDay).toEqual([0, 0, 0, 0, 0, 60_000, 120_000]);
  });

  test("cuts days at the reader's midnight and skips the change past raw retention", async () => {
    // 23:00 on Nov 19 in UTC-5 is 04:00 UTC on Nov 20.
    await job("lint", Date.UTC(2026, 10, 20, 4), 30_000);
    const report = await jobTypeTimes(createDb(env.DB), workspaceId, last(45), {
      now: NOW,
      utcOffset: -300,
    });
    expect(report.compare).toBe(false);
    expect(report.jobs[0]!.priorMs).toBeNull();
    expect(report.jobs[0]!.byDay.slice(-2)).toEqual([30_000, 0]);
  });

  test("compares this month with the same days of last month", async () => {
    await job("lint", Date.UTC(2026, 10, 1, 9), 30_000);
    await job("lint", Date.UTC(2026, 9, 15), 20_000);
    // Past Oct 20, so not in the same stretch of last month.
    await job("lint", Date.UTC(2026, 9, 25), 50_000);
    const month = { from: Date.UTC(2026, 10, 1), to: NOW };
    const report = await jobTypeTimes(
      createDb(env.DB),
      workspaceId,
      withPrior(month, Date.UTC(2026, 9, 1)),
      { now: NOW },
    );
    expect(report.start).toBe(Date.UTC(2026, 10, 1));
    expect(report.days).toBe(20);
    expect(report.compare).toBe(true);
    expect(report.jobs.map((j) => [j.job, j.ms, j.priorMs, j.byDay[0]])).toEqual([
      ["lint", 30_000, 20_000, 30_000],
    ]);
  });

  test("sorts each job's step time into parts, in the window only", async () => {
    const steps: StepTime[] = [
      ["Set up job", 2],
      ["Run actions/checkout@v4", 3],
      ["Run actions/setup-node@v4", 10],
      ["Run pnpm install", 20],
      ["Run pnpm test", 60],
      ["Post Run actions/setup-node@v4", 5],
      ["Complete job", 1],
    ];
    await job("test (node 22)", NOW - 60_000, 120_000, undefined, steps);
    await job("test (node 24)", NOW - 60_000, 120_000, undefined, steps);
    // No steps from GitHub.
    await job("test (node 24)", NOW - 60_000, 120_000);
    // Before the window.
    await job("test (node 22)", NOW - 9 * DAY_MS, 120_000, undefined, steps);

    const [test] = (await jobTypeTimes(createDb(env.DB), workspaceId, last(7), { now: NOW })).jobs;
    expect(test!.runs).toBe(3);
    expect(test!.stepped).toBe(2);
    expect(test!.parts).toEqual({
      runner: 6_000,
      checkout: 6_000,
      tools: 20_000,
      packages: 40_000,
      test: 120_000,
      cache: 10_000,
    });
    // setup-node saves its cache after the job, so the installs count as under a cache step.
    expect(test!.cached).toEqual(["packages"]);
  });
});

describe("jobRuns steps", () => {
  test("averages each step over successful runs, in the order steps run", async () => {
    await job("test", Date.now() - 60_000, 70_000, undefined, [
      ["Run actions/checkout@v4", 4],
      ["Run pnpm test", 60],
    ]);
    await job("test", Date.now() - 120_000, 50_000, undefined, [
      ["Run actions/checkout@v4", 2],
      ["Run pnpm test", 40],
    ]);
    // No steps from GitHub: left out of the average.
    await job("test", Date.now() - 180_000, 50_000);

    const { runs, steps } = await jobRuns(createDb(env.DB), workspaceId, {
      repositoryId: 77,
      workflow: "CI",
      name: "test",
      matrix: false,
    });
    expect(runs).toHaveLength(3);
    expect(steps).toEqual([
      { name: "Run actions/checkout@v4", part: "checkout", ms: 3_000 },
      { name: "Run pnpm test", part: "test", ms: 50_000 },
    ]);
  });
});
