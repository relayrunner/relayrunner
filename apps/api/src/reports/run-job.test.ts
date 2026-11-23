import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { jobUrl, runJob } from "./run-job.ts";
import * as testing from "../testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const HOUR = 3_600_000;
let jobIds = 950_000;

async function workspaceWithMachine() {
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, signedIn, "Run job", "run-job");
  const installationId = 7900;
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: "run-job-org",
    accountType: "Organization",
  });
  await testing.useInstallation(env, workspace.id, installationId);
  const [machine] = await db
    .insert(schema.machine)
    .values({ id: "run-job-mac", workspaceId: workspace.id, name: "mini" })
    .returning();
  return { db, installationId, workspaceId: workspace.id, machineId: machine.id };
}

function row(
  installationId: number,
  job: Partial<typeof schema.jobTiming.$inferInsert> & { seconds?: number; hoursAgo?: number },
) {
  const { seconds = 300, hoursAgo = 1, ...rest } = job;
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
    name: "test",
    labels: ["rr-0123456789ab"],
    conclusion: "success",
    runnerName: "mini",
    runnerGroupName: "Default",
    queuedAt: new Date(completed - seconds * 1000 - 5000),
    startedAt: new Date(completed - seconds * 1000),
    completedAt: new Date(completed),
    ...rest,
  };
}

describe("runJob", () => {
  test("names the job and gives its usual time on the machine", async () => {
    const { db, installationId, workspaceId, machineId } = await workspaceWithMachine();
    const past = [240, 300, 300, 310, 330, 360].map((seconds, i) =>
      row(installationId, { seconds, hoursAgo: i + 1, machineId }),
    );
    for (const each of past) await db.insert(schema.jobTiming).values(each);
    // Just queued: no runner, start or finish yet.
    const queued = row(installationId, {
      runAttempt: 2,
      conclusion: null,
      runnerName: null,
      startedAt: null,
      completedAt: null,
    });
    await db.insert(schema.jobTiming).values(queued);

    expect(await runJob(db, workspaceId, { jobId: queued.id, machineId })).toEqual({
      name: "test",
      workflow: "CI",
      repo: "acme/app",
      url: jobUrl("acme/app", queued.runId, queued.id),
      runAttempt: 2,
      typicalMs: 305_000,
    });
    // Another machine has no runs of it.
    expect(
      await runJob(db, workspaceId, { jobId: queued.id, machineId: "elsewhere" }),
    ).toMatchObject({ name: "test", typicalMs: null });
    // A job whose row isn't stored yet.
    expect(await runJob(db, workspaceId, { jobId: 1, machineId })).toBeUndefined();
  });
});

test("links to the job's page", () => {
  expect(jobUrl("acme/app", 42, 7)).toBe("https://github.com/acme/app/actions/runs/42/job/7");
});
