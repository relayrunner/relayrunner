import { beforeAll, describe, expect, test } from "vitest";
import { app } from "./app.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { countFinishedJob, jobCountReport } from "./job-counts.ts";
import { recordJobTiming } from "./job-timings.ts";
import * as testing from "./testing.ts";
import { accessEnv, accessJwt } from "./testing-access.ts";

const HOUR_MS = 3_600_000;
const MIGRATION = "20261113221716_job_count.sql";

let env: Env;
let jobIds = 0;

beforeAll(async () => {
  env = { ...(await testing.createTestEnv()), ...accessEnv };
});

async function workspace(operator = false) {
  const { cookie } = operator ? await testing.signInOperator(env) : await testing.signIn(env);
  const slug = `counts-${crypto.randomUUID().slice(0, 8)}`;
  return (await testing.createWorkspace(env, cookie, slug, slug)).workspace;
}

type Job = {
  status?: "in_progress" | "completed";
  conclusion?: string | null;
  labels?: string[];
  completedAt?: number;
  id?: number;
};

async function deliver(installationId: number, job: Job = {}) {
  const id = job.id ?? (jobIds += 1);
  const status = job.status ?? "completed";
  const completedAt = job.completedAt ?? Date.now();
  await recordJobTiming(createDb(env.DB), {
    event: "workflow_job",
    deliveryId: `count-${id}-${status}`,
    action: status,
    installationId,
    receivedAt: new Date().toISOString(),
    repository: { id: installationId * 10, fullName: "acme/app" },
    job: {
      id,
      runId: id,
      runAttempt: 1,
      name: "test",
      workflowName: "CI",
      status,
      conclusion: status === "completed" ? (job.conclusion ?? "success") : null,
      labels: job.labels ?? ["ubuntu-latest"],
      headBranch: "main",
      headSha: "abc",
      runnerName: "runner",
      runnerGroupName: "GitHub Actions",
      createdAt: new Date(completedAt - 20_000).toISOString(),
      startedAt: new Date(completedAt - 15_000).toISOString(),
      completedAt: status === "completed" ? new Date(completedAt).toISOString() : null,
    },
  });
  return id;
}

async function countsFor(installationId: number) {
  return createDb(env.DB).query.jobCount.findMany({
    where: (t, { eq }) => eq(t.installationId, installationId),
    orderBy: (t, { asc }) => asc(t.hour),
  });
}

describe("job counts", () => {
  test("count each finished job once, by result, in its hour", async () => {
    const { installationId } = await workspace();
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;
    const id = await deliver(installationId, { status: "in_progress", completedAt: hour + 60_000 });
    await deliver(installationId, { id, completedAt: hour + 60_000 });
    // A redelivered `completed` changes nothing.
    await deliver(installationId, { id, completedAt: hour + 60_000 });
    await deliver(installationId, { conclusion: "failure", completedAt: hour + 120_000 });
    await deliver(installationId, { conclusion: "timed_out", completedAt: hour + 120_000 });
    await deliver(installationId, { conclusion: "cancelled", completedAt: hour + HOUR_MS });
    // Neither counts: a skipped job never ran, and a pick only routes its run.
    await deliver(installationId, { conclusion: "skipped", completedAt: hour });
    await deliver(installationId, { labels: ["RelayRunner"], completedAt: hour });

    expect(await countsFor(installationId)).toEqual([
      { hour: new Date(hour), installationId, success: 1, failed: 2, cancelled: 0 },
      { hour: new Date(hour + HOUR_MS), installationId, success: 0, failed: 0, cancelled: 1 },
    ]);
  });

  test("the report reads the range from the rollups and leaves out excluded installations", async () => {
    const fresh = await testing.createTestEnv();
    const db = createDb(fresh.DB);
    const now = Date.UTC(2026, 10, 13, 12, 30);
    await db.insert(schema.githubInstallation).values(
      [1, 2].map((id) => ({
        id,
        accountId: id,
        accountLogin: `org-${id}`,
        accountType: "Organization",
      })),
    );
    const at = (hoursAgo: number) => Date.UTC(2026, 10, 13, 12) - hoursAgo * HOUR_MS;
    async function count(installationId: number, conclusion: string, hoursAgo: number, times = 1) {
      for (let i = 0; i < times; i += 1)
        await countFinishedJob(db, installationId, conclusion, new Date(at(hoursAgo) + 60_000));
    }
    await count(1, "success", 0, 3);
    await count(1, "failure", 4);
    await count(2, "success", 4, 5);
    await count(2, "cancelled", 4, 2);
    // Past the 1-day range, inside the 7-day one.
    await count(1, "success", 30, 10);

    const day = await jobCountReport(db, { days: 1, now });
    expect(day.totals).toEqual({ success: 8, failed: 1, cancelled: 2 });
    expect(day.hours).toEqual([
      { at: at(4), success: 5, failed: 1, cancelled: 2 },
      { at: at(0), success: 3, failed: 0, cancelled: 0 },
    ]);
    expect(day.installations).toEqual([
      { installationId: 2, success: 5, failed: 0, cancelled: 2 },
      { installationId: 1, success: 3, failed: 1, cancelled: 0 },
    ]);

    // The week's breakdown comes from the per-day rollup and matches the chart's totals.
    const week = await jobCountReport(db, { days: 7, exclude: [2], now });
    expect(week.totals).toEqual({ success: 13, failed: 1, cancelled: 0 });
    expect(week.hours.map((row) => row.at)).toEqual([at(30), at(4), at(0)]);
    expect(week.installations).toEqual([
      { installationId: 1, success: 13, failed: 1, cancelled: 0 },
    ]);
  });

  test("the migration counts the jobs job_timing already holds", async () => {
    const before = await testing.createTestEnv({ before: MIGRATION });
    const hour = Date.UTC(2026, 10, 13, 10);
    await before.DB.prepare(
      "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (1, 1, 'org', 'Organization', 0, 0)",
    ).run();
    const rows: [string | null, string, number | null][] = [
      ["success", '["ubuntu-latest"]', hour + 1],
      ["failure", '["ubuntu-latest"]', hour + 2],
      ["cancelled", '["ubuntu-latest"]', hour + HOUR_MS],
      ["skipped", '["ubuntu-latest"]', hour],
      ["success", '["relayrunner"]', hour],
      [null, '["ubuntu-latest"]', null],
    ];
    for (const [index, [conclusion, labels, completedAt]] of rows.entries())
      await before.DB.prepare(
        "insert into job_timing (id, installation_id, repository_id, repository_full_name, run_id, run_attempt, name, labels, conclusion, completed_at, created_at, updated_at) values (?, 1, 1, 'org/app', 1, 1, 'test', ?, ?, ?, 0, 0)",
      )
        .bind(index + 1, labels, conclusion, completedAt)
        .run();
    await testing.applyMigration(before, MIGRATION);
    const read = async (query: string) => (await before.DB.prepare(query).all()).results;
    const hours = [
      { hour, success: 1, failed: 1, cancelled: 0 },
      { hour: hour + HOUR_MS, success: 0, failed: 0, cancelled: 1 },
    ];
    expect(
      await read("select hour, success, failed, cancelled from job_count order by hour"),
    ).toEqual(hours);
    expect(await read("select * from job_count_hour order by hour")).toEqual(hours);
    expect(await read("select day, success, failed, cancelled from job_count_day")).toEqual([
      { day: Date.UTC(2026, 10, 13), success: 1, failed: 1, cancelled: 1 },
    ]);
  });
});

describe("/api/admin/jobs", () => {
  async function get(query: string, cookie: string) {
    const headers = new Headers({ cookie, "Cf-Access-Jwt-Assertion": await accessJwt() });
    return app.request(`/api/admin/jobs${query}`, { headers }, env);
  }

  test("leaves our own workspaces out unless asked", async () => {
    const op = await testing.signInOperator(env);
    const theirs = await workspace();
    const ours = await workspace(true);
    await deliver(theirs.installationId, { conclusion: "failure" });
    await deliver(ours.installationId);

    type Body = {
      days: number;
      internalWorkspaces: number;
      installations: { installationId: number; name: string; internal: boolean }[];
    };
    const shown = (await (await get("?days=1", op.cookie)).json()) as Body;
    expect(shown.days).toBe(1);
    expect(shown.internalWorkspaces).toBeGreaterThan(0);
    const ids = shown.installations.map((row) => row.installationId);
    expect(ids).toContain(theirs.installationId);
    expect(ids).not.toContain(ours.installationId);

    const all = (await (await get("?days=1&internal=1", op.cookie)).json()) as Body;
    expect(
      all.installations.find((row) => row.installationId === ours.installationId),
    ).toMatchObject({ name: ours.name, internal: true });

    expect((await get("?days=3", op.cookie)).status).toBe(400);
    const regular = await testing.signIn(env);
    expect((await get("", regular.cookie)).status).toBe(403);
  });
});
