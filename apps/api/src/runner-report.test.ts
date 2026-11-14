import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { RunnerReport } from "./runner-report.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

let workspaces = 0;
let jobIds = 950_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function connectedWorkspace() {
  workspaces += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Runner ${workspaces}`,
    `runner-${workspaces}`,
  );
  const installationId = 8100 + workspaces;
  await createDb(env.DB)
    .insert(schema.githubInstallation)
    .values({
      id: installationId,
      accountId: installationId,
      accountLogin: `runner-org-${workspaces}`,
      accountType: "Organization",
    });
  await testing.useInstallation(env, workspace.id, installationId);
  return { cookie, installationId, workspaceId: workspace.id };
}

type Timing = typeof schema.jobTiming.$inferInsert;

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
  for (let i = 0; i < rows.length; i += 5)
    await db.insert(schema.jobTiming).values(rows.slice(i, i + 5));
}

async function report(cookie: string, key: string, query = "") {
  const res = await testing.call(
    env,
    `/job-times/runner?key=${encodeURIComponent(key)}${query}`,
    cookie,
  );
  if (res.status !== 200) throw new Error(await res.text());
  return (await res.json()) as RunnerReport;
}

describe("runner report", () => {
  test("adds up one cloud runner's label sets by day, with its newest jobs", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    await insert([
      // Two label sets that are both Linux 2-core, on two days.
      timing(installationId, 60, { hoursAgo: 1 }),
      timing(installationId, 120, { labels: ["ubuntu-24.04"], hoursAgo: 2 }),
      timing(installationId, 30, { conclusion: "failure", hoursAgo: 2 * 24 + 1 }),
      // Another runner and an older job: left out.
      timing(installationId, 600, { labels: ["macos-15"], hoursAgo: 1 }),
      timing(installationId, 600, { hoursAgo: 20 * 24 }),
    ]);
    const result = await report(cookie, "github:linux-2-core");
    expect(result.environment).toMatchObject({ key: "github:linux-2-core", label: "Linux 2-core" });
    expect(result.stat).toMatchObject({ runs: 3, successes: 2, medianMs: 90_000 });
    expect(result.daily.reduce((sum, day) => sum + day.busyMs, 0)).toBe(210_000);
    expect(result.daily.reduce((sum, day) => sum + day.jobs, 0)).toBe(3);
    expect(result.daily.reduce((sum, day) => sum + day.failures, 0)).toBe(1);
    expect(result.recent.map((job) => (job.completedAt - job.startedAt) / 1000)).toEqual([
      60, 120, 30,
    ]);
    expect(result.connections).toBeNull();
  });

  test("cuts days at the reader's midnight", async () => {
    const { cookie, installationId } = await connectedWorkspace();
    await insert([timing(installationId, 60)]);
    const result = await report(cookie, "github:linux-2-core", "&utcOffset=120");
    expect(result.daily).toHaveLength(1);
    // Local midnight at UTC+2 is 22:00 UTC the day before.
    expect((result.daily[0].day + 120 * 60_000) % DAY).toBe(0);
  });

  test("reads a machine's jobs and connections, and nothing of another workspace's", async () => {
    const { cookie, installationId, workspaceId } = await connectedWorkspace();
    const db = createDb(env.DB);
    const id = `runner-mac-${installationId}`;
    await db.insert(schema.machine).values({ id, workspaceId, name: "mighty-m1", chip: "M1" });
    await insert([
      timing(installationId, 40, { machineId: id, labels: ["rr-0123456789ab"], hoursAgo: 1 }),
      timing(installationId, 50, { machineId: id, labels: ["rr-0123456789ab"], hoursAgo: 3 }),
    ]);
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
    await db.insert(schema.activityEvent).values([
      { workspaceId, machineId: id, type: "machine.connected", data: {}, occurredAt: at(10) },
      { workspaceId, machineId: id, type: "machine.disconnected", data: {}, occurredAt: at(5) },
      { workspaceId, machineId: id, type: "machine.connected", data: {}, occurredAt: at(4) },
    ]);
    const result = await report(cookie, `machine:${id}`);
    expect(result.environment).toMatchObject({ label: "mighty-m1", detail: "M1" });
    expect(result.stat).toMatchObject({ runs: 2, medianMs: 45_000 });
    expect(result.recent).toHaveLength(2);
    expect(result.connections?.map((c) => c.online)).toEqual([true, false, true]);

    const { cookie: stranger } = await connectedWorkspace();
    const theirs = await report(stranger, `machine:${id}`);
    expect(theirs.stat.runs).toBe(0);
    expect(theirs.recent).toEqual([]);
    expect(theirs.connections).toBeNull();
  });
});
