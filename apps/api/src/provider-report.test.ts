import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  type ProviderReport,
  type ProvidersOverview,
  providerReport,
  providersOverview,
} from "./provider-report.ts";
import { percentilesOf, providerTrends } from "./provider-trends.ts";
import { lastDays, withPrior } from "./report-window.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

let jobIds = 950_000;

type Timing = typeof schema.jobTiming.$inferInsert;

// A finished job, `seconds` long, ending an hour ago and queued 5s before it started.
function timing(installationId: number, seconds: number, job: Partial<Timing> = {}): Timing {
  jobIds += 1;
  const completed = Date.now() - 3_600_000;
  return {
    id: jobIds,
    installationId,
    repositoryId: installationId * 10,
    repositoryFullName: "acme/app",
    runId: jobIds,
    runAttempt: 1,
    workflowName: "CI",
    name: "test",
    labels: ["blacksmith-4vcpu-ubuntu-2404"],
    conclusion: "success",
    runnerName: "runner",
    runnerGroupName: "Default",
    queuedAt: new Date(completed - seconds * 1000 - 5000),
    startedAt: new Date(completed - seconds * 1000),
    completedAt: new Date(completed),
    ...job,
  };
}

async function report<T = ProviderReport>(cookie: string, path: string) {
  const res = await testing.call(env, path, cookie);
  return { status: res.status, body: (await res.json()) as T };
}

describe("provider report", () => {
  test("totals the provider's jobs and splits them by runner type", async () => {
    const { cookie: signedIn } = await testing.signIn(env);
    const { workspace, cookie } = await testing.createWorkspace(
      env,
      signedIn,
      "Providers",
      "providers",
    );
    const installationId = 8100;
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: installationId,
      accountId: installationId,
      accountLogin: "providers-org",
      accountType: "Organization",
    });
    await testing.useInstallation(env, workspace.id, installationId);
    // A public repo: GitHub's standard runners are free there.
    await db.insert(schema.githubRepository).values({
      id: 99,
      installationId,
      fullName: "acme/oss",
      private: false,
      githubStateAt: new Date(),
    });
    const rows = [
      timing(installationId, 60),
      timing(installationId, 120),
      timing(installationId, 90, { conclusion: "failure" }),
      timing(installationId, 30, { labels: ["blacksmith-8vcpu-ubuntu-2404"] }),
      // Another provider's job, and a skipped one: neither counts.
      timing(installationId, 45, { labels: ["ubuntu-latest"], runnerGroupName: "GitHub Actions" }),
      timing(installationId, 10, { conclusion: "skipped" }),
      timing(installationId, 45, {
        labels: ["ubuntu-latest"],
        runnerGroupName: "GitHub Actions",
        repositoryId: 99,
        repositoryFullName: "acme/oss",
        workflowName: "Lint",
      }),
    ];
    for (let i = 0; i < rows.length; i += 5)
      await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));

    const { status, body } = await report(cookie, "/providers/blacksmith?days=7");
    expect(status).toBe(200);
    expect(body).toMatchObject({ provider: "blacksmith", days: 7, jobs: 4, failures: 1 });
    expect(body.stat).toMatchObject({ runs: 4, successes: 3, medianMs: 60_000, waitMs: 5000 });
    // Each job rounds up to whole minutes: 1 + 2 + 2 on 4 vCPU, 1 on 8 vCPU.
    expect(body).toMatchObject({ billedMinutes: 6, cost: 0.056, unpricedJobs: 0 });
    expect(body.runners.map((r) => [r.key, r.jobs, r.failures, r.perMinute, r.cost])).toEqual([
      ["blacksmith:blacksmith-4vcpu-ubuntu-2404", 3, 1, 0.008, 0.04],
      ["blacksmith:blacksmith-8vcpu-ubuntu-2404", 1, 0, 0.016, 0.016],
    ]);
    expect(body.workflows).toEqual([{ repository: "acme/app", workflow: "CI", jobs: 4 }]);

    // The private repo's minute is billed, the public repo's is free.
    const github = await report(cookie, "/providers/github");
    expect(github.body).toMatchObject({ days: 14, jobs: 2, failures: 0, cost: 0.006 });
    expect(github.body.workflows.map((w) => w.workflow)).toEqual(["CI", "Lint"]);

    const overview = await report<ProvidersOverview>(cookie, "/providers?days=7");
    expect(overview.body.providers.map((p) => [p.provider, p.jobs, p.cost])).toEqual([
      ["blacksmith", 4, 0.056],
      ["github", 2, 0.006],
    ]);
    // Each provider carries its runner types, as its own page lists them.
    expect(overview.body.providers[0]?.runners).toEqual(body.runners);

    expect((await report(cookie, "/providers/nope")).status).toBe(404);
  });

  test("prices each job at the rate on the day it ran", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Repriced", "repriced");
    const installationId = 8300;
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: installationId,
      accountId: installationId,
      accountLogin: "repriced-org",
      accountType: "Organization",
    });
    await testing.useInstallation(env, workspace.id, installationId);
    // Ubicloud's standard 2 vCPU minute went from $0.001 to $0.00125 on 2026-09-01.
    const at = (day: string, minutes: number) => {
      const completed = Date.parse(`${day}T12:00:00Z`);
      return timing(installationId, minutes * 60, {
        labels: ["ubicloud-standard-2"],
        queuedAt: new Date(completed - minutes * 60_000),
        startedAt: new Date(completed - minutes * 60_000),
        completedAt: new Date(completed),
      });
    };
    await db.insert(schema.jobTiming).values([at("2026-08-25", 100), at("2026-09-05", 100)]);

    const now = Date.parse("2026-09-10");
    const body = await providerReport(db, workspace.id, "ubicloud", lastDays(30, now), now);
    expect(body).toMatchObject({ jobs: 2, billedMinutes: 200 });
    expect(body.cost).toBeCloseTo(100 * 0.001 + 100 * 0.00125, 3);
    // One runner type, shown at today's price.
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0]?.perMinute).toBeCloseTo(0.00125, 6);
    // Its list prices, with each one's history.
    expect(body.prices.find((p) => p.rate === "standard")).toEqual({
      rate: "standard",
      per: "vcpu",
      history: [
        { usd: 0.0004, from: "2023-01-01" },
        { usd: 0.0005, from: "2026-05-01" },
        { usd: 0.000625, from: "2026-09-01" },
      ],
    });
  });

  test("counts quick starts and runner failures, and minutes a day with the window before", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Share", "share");
    const installationId = 8400;
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: installationId,
      accountId: installationId,
      accountLogin: "share-org",
      accountType: "Organization",
    });
    await testing.useInstallation(env, workspace.id, installationId);
    const DAY = 86_400_000;
    const now = Date.parse("2026-09-10T18:00:00Z");
    const origin = Date.parse("2026-09-07T00:00:00Z");
    // A job of `minutes` that finished at `completed`, after waiting `waitS` seconds.
    const at = (completed: number, minutes: number, waitS: number, job: Partial<Timing> = {}) =>
      timing(installationId, minutes * 60, {
        queuedAt: new Date(completed - minutes * 60_000 - waitS * 1000),
        startedAt: new Date(completed - minutes * 60_000),
        completedAt: new Date(completed),
        ...job,
      });
    const rows = [
      // In the window: Sep 7 and Sep 9.
      at(origin + 12 * 3_600_000, 3, 5),
      at(origin + 2 * DAY + 3_600_000, 2, 120),
      at(origin + 2 * DAY + 7_200_000, 1, 10, { conclusion: "failure", ranSteps: false }),
      at(origin + 2 * DAY + 9_000_000, 4, 5, {
        labels: ["ubuntu-latest"],
        runnerGroupName: "GitHub Actions",
      }),
      // The window before (Sep 3–7), and a job before that, which neither counts.
      at(origin - 2 * DAY, 10, 5),
      at(origin - 9 * DAY, 30, 5),
    ];
    for (let i = 0; i < rows.length; i += 5)
      await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));

    // Sep 7 06:00 to now, against the 3.5 days before, in days from midnight on Sep 7.
    const window = withPrior({ from: origin + 6 * 3_600_000, to: now });
    const body = await providersOverview(db, workspace.id, window, { bucketMs: DAY, origin }, now);
    const blacksmith = body.providers.find((p) => p.provider === "blacksmith");
    expect(blacksmith).toMatchObject({
      jobs: 3,
      billedMinutes: 6,
      waits: 3,
      quickStarts: 2,
      runnerFailures: 1,
      priorBilledMinutes: 10,
    });
    expect(body.providers.find((p) => p.provider === "github")?.priorBilledMinutes).toBe(0);
    expect(body.bucketMs).toBe(DAY);
    expect(
      body.buckets.map((b) => [new Date(b.start).toISOString().slice(0, 10), b.minutes]),
    ).toEqual([
      ["2026-09-07", { blacksmith: 3 }],
      ["2026-09-08", {}],
      ["2026-09-09", { blacksmith: 3, github: 4 }],
      ["2026-09-10", {}],
    ]);
  });

  test("percentiles a day at a time for each runner type", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Trends", "trends");
    const installationId = 8500;
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: installationId,
      accountId: installationId,
      accountLogin: "trends-org",
      accountType: "Organization",
    });
    await testing.useInstallation(env, workspace.id, installationId);
    const DAY = 86_400_000;
    const origin = Date.parse("2026-09-07T00:00:00Z");
    const at = (completed: number, minutes: number, waitS: number, job: Partial<Timing> = {}) =>
      timing(installationId, minutes * 60, {
        queuedAt: new Date(completed - minutes * 60_000 - waitS * 1000),
        startedAt: new Date(completed - minutes * 60_000),
        completedAt: new Date(completed),
        ...job,
      });
    const noon = origin + 12 * 3_600_000;
    const rows = [
      at(noon, 1, 10),
      at(noon + 1000, 2, 20),
      at(noon + 2000, 3, 30),
      at(noon + 3000, 1, 40, { conclusion: "failure", ranSteps: false }),
      // The next day: too few for percentiles.
      at(noon + DAY, 5, 5),
      // Another runner type, and another provider, which is left out.
      at(noon, 2, 5, { labels: ["blacksmith-2vcpu-ubuntu-2404"] }),
      at(noon, 2, 5, { labels: ["ubuntu-latest"], runnerGroupName: "GitHub Actions" }),
    ];
    for (let i = 0; i < rows.length; i += 5)
      await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));

    const window = { from: origin, to: origin + 2 * DAY };
    const body = await providerTrends(db, workspace.id, "blacksmith", window, {
      bucketMs: DAY,
      origin,
    });
    expect(body.runners.map((r) => [r.label, r.jobs])).toEqual([
      [expect.stringContaining("4"), 5],
      [expect.stringContaining("2"), 1],
    ]);
    const [first, second] = body.runners[0]!.points;
    expect(first).toMatchObject({ jobs: 4, runnerFailures: 1 });
    expect(first!.wait).toMatchObject({ p50: 25_000, p99: 39_700 });
    expect(first!.run).toMatchObject({ p50: 120_000 });
    expect(second).toMatchObject({ jobs: 1, wait: null, run: null });
  });
});

test("percentilesOf needs a few values", () => {
  expect(percentilesOf([1, 2])).toBeNull();
  expect(percentilesOf([30, 10, 20])).toEqual({ p50: 20, p75: 25, p90: 28, p95: 29, p99: 30 });
});
