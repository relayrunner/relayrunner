import { beforeEach, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { jobTypeTimes } from "./job-type-times.ts";
import { DAY_MS } from "./job-timings.ts";
import * as testing from "./testing.ts";

let env: Env;
let workspaceId: string;
let installationId: number;
let ids = 0;

// Noon UTC, so days ago and local midnights fall where the tests expect.
const NOW = Date.UTC(2026, 10, 20, 12);

async function job(name: string, completedAt: number, runMs: number, labels = ["ubuntu-latest"]) {
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

    const report = await jobTypeTimes(createDb(env.DB), workspaceId, 7, { now: NOW });
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
    const report = await jobTypeTimes(createDb(env.DB), workspaceId, 30, {
      now: NOW,
      utcOffset: -300,
    });
    expect(report.compare).toBe(false);
    expect(report.jobs[0]!.priorMs).toBeNull();
    expect(report.jobs[0]!.byDay.slice(-2)).toEqual([30_000, 0]);
  });
});
