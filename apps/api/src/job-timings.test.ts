import type { WebhookMessage, WorkflowJob } from "@relayrunner/github-webhooks";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import {
  JOB_TIMING_RETENTION_DAYS,
  purgeOldJobTimings,
  RAW_RETENTION_DAYS,
  runnerClass,
  type UsageReport,
} from "./job-timings.ts";
import * as testing from "./testing.ts";
import { processWebhook } from "./webhook-queue.ts";

describe("runnerClass", () => {
  test.each([
    [["ubuntu-latest"], null, "linux-2-core"],
    [["ubuntu-24.04"], "GitHub Actions", "linux-2-core"],
    [["ubuntu-24.04-arm"], null, "linux-arm-2-core"],
    [["windows-11-arm"], null, "windows-arm-2-core"],
    [["ubuntu-slim"], null, "linux-1-core"],
    [["windows-latest"], null, "windows-2-core"],
    [["macos-15"], null, "macos"],
    [["macOS-latest"], null, "macos"],
    [["self-hosted", "linux"], null, "self-hosted"],
    [["RelayRunner"], null, "self-hosted"],
    [["rr-0123456789ab"], null, "self-hosted"],
    [["build-box"], "Default", "self-hosted"],
    [["ubuntu-latest-8-cores"], "GitHub Actions", "other"],
    [["build-box"], null, "other"],
  ] as const)("%j in group %s is %s", (labels, group, expected) => {
    expect(runnerClass([...labels], group)).toBe(expected);
  });
});

let env: Env;

beforeAll(async () => {
  env = {
    ...(await testing.createTestEnv()),
    PICK_RUNNER: { getByName: () => ({ start: vi.fn() }) },
  } as unknown as Env;
});

let ids = 0;

async function connectedWorkspace() {
  ids += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Usage ${ids}`,
    `usage-${ids}`,
  );
  const installationId = 4000 + ids;
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: `usage-org-${ids}`,
    accountType: "Organization",
  });
  await testing.useInstallation(env, workspace.id, installationId);
  await db.insert(schema.githubRepository).values([
    {
      id: installationId * 10,
      installationId,
      fullName: "acme/private",
      private: true,
      githubStateAt: new Date(),
    },
    {
      id: installationId * 10 + 1,
      installationId,
      fullName: "acme/public",
      private: false,
      githubStateAt: new Date(),
    },
  ]);
  return { cookie, installationId };
}

let jobIds = 50_000;

// A finished job that ran for `seconds`, ending an hour ago.
function finished(
  installationId: number,
  seconds: number,
  job: Partial<WorkflowJob> = {},
  repo: "private" | "public" = "private",
): WebhookMessage {
  jobIds += 1;
  const completed = Date.now() - 3_600_000;
  return {
    event: "workflow_job",
    deliveryId: `usage-${jobIds}`,
    action: "completed",
    installationId,
    receivedAt: new Date().toISOString(),
    repository: {
      id: installationId * 10 + (repo === "public" ? 1 : 0),
      fullName: `acme/${repo}`,
    },
    job: {
      id: jobIds,
      runId: jobIds,
      runAttempt: 1,
      name: "check",
      workflowName: "CI",
      status: "completed",
      conclusion: "success",
      labels: ["ubuntu-latest"],
      headBranch: "main",
      headSha: "abc",
      runnerName: "GitHub Actions 1",
      runnerGroupName: "GitHub Actions",
      createdAt: new Date(completed - seconds * 1000 - 5000).toISOString(),
      startedAt: new Date(completed - seconds * 1000).toISOString(),
      completedAt: new Date(completed).toISOString(),
      ...job,
    },
  };
}

async function usage(cookie: string, days = 30) {
  const res = await testing.call(env, `/usage?days=${days}`, cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as UsageReport;
}

describe("usage report", () => {
  test("counts short jobs and the cost of rounding up, for jobs RelayRunner didn't route", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    // 2 short Linux jobs (1 billed minute each), one 90s Linux job (2 minutes), one 30s macOS job.
    await processWebhook(env, finished(installationId, 12));
    await processWebhook(env, finished(installationId, 45));
    await processWebhook(env, finished(installationId, 90));
    await processWebhook(env, finished(installationId, 30, { labels: ["macos-latest"] }));
    // Free: a public repo, a self-hosted runner. Not counted: skipped, and never started.
    await processWebhook(env, finished(installationId, 20, {}, "public"));
    await processWebhook(env, finished(installationId, 20, { labels: ["self-hosted"] }));
    await processWebhook(env, finished(installationId, 0, { conclusion: "skipped" }));
    await processWebhook(
      env,
      finished(installationId, 0, { conclusion: "cancelled", startedAt: null, runnerName: null }),
    );

    const report = await usage(cookie);
    expect(report.totals).toMatchObject({
      jobs: 6,
      shortJobs: 5,
      billedMinutes: 7,
      shortBilledMinutes: 5,
      // 4 Linux minutes at $0.006 + 1 macOS minute at $0.062.
      cost: 0.086,
      // 2 short Linux minutes + 1 short macOS minute.
      shortCost: 0.074,
    });
    const linux = report.byRunner.find((row) => row.runnerClass === "linux-2-core");
    expect(linux).toMatchObject({ jobs: 4, shortJobs: 3, billedMinutes: 5, cost: 0.024 });
    // (4 billed - 147s run) * $0.006, plus the public job's free minute.
    expect(linux?.roundingCost).toBeCloseTo((4 - 147 / 60) * 0.006, 3);
    expect(report.byRepository[0]).toMatchObject({
      repository: "acme/private",
      shortJobs: 4,
      shortCost: 0.074,
    });
  });

  test("follows a job through its webhooks, counting it once it finishes", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    const done = finished(installationId, 10);
    if (done.event !== "workflow_job") throw new Error("expected a job");
    const timingOf = async () => {
      const [row] = await createDb(env.DB)
        .select()
        .from(schema.jobTiming)
        .where(eq(schema.jobTiming.id, done.job.id));
      return row;
    };
    const queued = {
      ...done,
      deliveryId: "queued",
      action: "queued",
      job: {
        ...done.job,
        status: "queued",
        conclusion: null,
        runnerName: null,
        runnerGroupName: null,
        startedAt: null,
        completedAt: null,
      },
    } satisfies WebhookMessage;
    const running = {
      ...done,
      deliveryId: "running",
      action: "in_progress",
      job: { ...done.job, status: "in_progress", conclusion: null, completedAt: null },
    } satisfies WebhookMessage;

    // Queued, then running: stored, but no report counts it yet.
    await processWebhook(env, queued);
    expect(await timingOf()).toMatchObject({
      startedAt: null,
      runnerName: null,
      completedAt: null,
    });
    await processWebhook(env, running);
    expect(await timingOf()).toMatchObject({
      runnerName: "GitHub Actions 1",
      runnerGroupName: "GitHub Actions",
      completedAt: null,
    });
    expect((await usage(cookie)).totals.jobs).toBe(0);

    await processWebhook(env, done);
    await processWebhook(env, { ...done, deliveryId: "redelivered" });
    // A late delivery never rewinds a finished job.
    await processWebhook(env, { ...running, deliveryId: "late" });
    expect((await timingOf())?.completedAt?.toISOString()).toBe(done.job.completedAt);
    expect((await usage(cookie)).totals).toMatchObject({ jobs: 1, shortJobs: 1 });
  });

  test("purges timings past retention", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    await processWebhook(env, finished(installationId, 10));
    const old = finished(installationId, 10);
    if (old.event !== "workflow_job") throw new Error("expected a job");
    const at = Date.now() - (JOB_TIMING_RETENTION_DAYS + 1) * 86_400_000;
    old.job.startedAt = new Date(at - 10_000).toISOString();
    old.job.completedAt = new Date(at).toISOString();
    await processWebhook(env, old);
    expect(await purgeOldJobTimings(createDb(env.DB))).toBeGreaterThanOrEqual(1);
    const rows = await createDb(env.DB)
      .select({ id: schema.jobTiming.id })
      .from(schema.jobTiming)
      .where(eq(schema.jobTiming.installationId, installationId));
    expect(rows).toHaveLength(1);
    expect((await usage(cookie)).totals.jobs).toBe(1);
  });

  test("rolls jobs past raw retention up into daily totals the 90-day report still counts", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    const db = createDb(env.DB);
    // Noon UTC, 40 days ago, so every job lands on the same day.
    const day = Math.floor((Date.now() - 40 * 86_400_000) / 86_400_000) * 86_400_000;
    const at = (message: WebhookMessage, minutes: number) => {
      if (message.event !== "workflow_job") throw new Error("expected a job");
      const completed = day + 12 * 3_600_000 + minutes * 60_000;
      const seconds =
        (Date.parse(message.job.completedAt!) - Date.parse(message.job.startedAt!)) / 1000;
      message.job.startedAt = new Date(completed - seconds * 1000).toISOString();
      message.job.completedAt = new Date(completed).toISOString();
      return message;
    };
    await processWebhook(env, finished(installationId, 10));
    await processWebhook(env, at(finished(installationId, 12), 0));
    await processWebhook(env, at(finished(installationId, 90), 1));
    await processWebhook(env, at(finished(installationId, 20, { labels: ["macos-latest"] }), 2));
    await processWebhook(env, at(finished(installationId, 0, { conclusion: "skipped" }), 3));
    const before = await usage(cookie, 90);

    await purgeOldJobTimings(db);
    const raw = await db
      .select({ id: schema.jobTiming.id })
      .from(schema.jobTiming)
      .where(eq(schema.jobTiming.installationId, installationId));
    expect(raw).toHaveLength(1);
    const rolled = await db
      .select()
      .from(schema.jobTimingDaily)
      .where(eq(schema.jobTimingDaily.installationId, installationId));
    expect(rolled).toHaveLength(2);
    expect(rolled.find((row) => row.labels[0] === "ubuntu-latest")).toMatchObject({
      day: new Date(day),
      runnerGroupName: "GitHub Actions",
      jobs: 2,
      shortJobs: 1,
      runMs: 102_000,
      billedMinutes: 3,
      shortBilledMinutes: 1,
    });
    // The report reads the same either way; the last 30 days only see the recent job.
    expect(await usage(cookie, 90)).toEqual(before);
    expect((await usage(cookie, 90)).totals).toMatchObject({ jobs: 4, shortJobs: 3 });
    expect((await usage(cookie)).totals.jobs).toBe(1);

    // A job on that day that finished late adds to its rows rather than replacing them.
    await processWebhook(env, at(finished(installationId, 30), 4));
    await purgeOldJobTimings(db);
    expect((await usage(cookie, 90)).totals).toMatchObject({ jobs: 5, shortJobs: 4 });
  });

  test("keeps jobs within raw retention as their own rows", async () => {
    const { installationId } = await connectedWorkspace();
    const db = createDb(env.DB);
    const recent = finished(installationId, 10);
    if (recent.event !== "workflow_job") throw new Error("expected a job");
    const at = Date.now() - (RAW_RETENTION_DAYS - 1) * 86_400_000;
    recent.job.startedAt = new Date(at - 10_000).toISOString();
    recent.job.completedAt = new Date(at).toISOString();
    await processWebhook(env, recent);
    await purgeOldJobTimings(db);
    const raw = await db
      .select({ id: schema.jobTiming.id })
      .from(schema.jobTiming)
      .where(eq(schema.jobTiming.installationId, installationId));
    expect(raw).toHaveLength(1);
  });

  test("purges jobs that never finished after a week", async () => {
    const { installationId } = await connectedWorkspace();
    const db = createDb(env.DB);
    const stuck = finished(installationId, 10);
    const fresh = finished(installationId, 10);
    for (const message of [stuck, fresh]) {
      if (message.event !== "workflow_job") throw new Error("expected a job");
      await processWebhook(env, {
        ...message,
        action: "in_progress",
        job: { ...message.job, status: "in_progress", conclusion: null, completedAt: null },
      });
    }
    if (stuck.event !== "workflow_job") throw new Error("expected a job");
    await db
      .update(schema.jobTiming)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(schema.jobTiming.id, stuck.job.id));
    expect(await purgeOldJobTimings(db)).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select({ id: schema.jobTiming.id })
      .from(schema.jobTiming)
      .where(eq(schema.jobTiming.installationId, installationId));
    expect(rows).toHaveLength(1);
  });

  test("another workspace's jobs stay out", async () => {
    const { installationId } = await connectedWorkspace();
    await processWebhook(env, finished(installationId, 10));
    const { cookie } = await connectedWorkspace();
    expect((await usage(cookie)).totals.jobs).toBe(0);
  });
});
