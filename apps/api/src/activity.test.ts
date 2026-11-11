import type { ActivityPage } from "@relayrunner/activity";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { recordEvent, recordMachineEvent } from "./activity.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  ({ proxy, env } = await testing.startD1());
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

let ids = 0;

// A signed-in owner of a fresh workspace with one machine.
async function workspaceWithMachine() {
  ids += 1;
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace, cookie } = await testing.createWorkspace(
    env,
    signedIn,
    `Log ${ids}`,
    `log-${ids}`,
  );
  const machineId = `log-machine-${ids}`;
  await createDb(env.DB)
    .insert(schema.machine)
    .values({ id: machineId, workspaceId: workspace.id, name: "laptop" });
  return { cookie, workspaceId: workspace.id, machineId };
}

async function activity(cookie: string, query = "") {
  const res = await testing.call(env, `/activity${query}`, cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as ActivityPage;
}

describe("Activity log", () => {
  test("logs a machine coming online and going offline in its workspace", async () => {
    const { cookie, machineId } = await workspaceWithMachine();
    const db = createDb(env.DB);
    await recordMachineEvent(db, machineId, {
      type: "machine.connected",
      data: { runnerVersion: "2.330.0" },
    });
    await recordMachineEvent(db, machineId, {
      type: "machine.disconnected",
      data: { reason: "timeout" },
    });
    const { items } = await activity(cookie);
    expect(items).toMatchObject([
      {
        type: "machine.disconnected",
        data: { machineName: "laptop", reason: "timeout" },
        machine: { id: machineId, name: "laptop" },
        actor: null,
        job: null,
      },
      { type: "machine.connected", data: { machineName: "laptop", runnerVersion: "2.330.0" } },
    ]);
  });

  test("shows a machine's current name, and its old name once it's gone", async () => {
    const { cookie, machineId } = await workspaceWithMachine();
    const db = createDb(env.DB);
    await recordMachineEvent(db, machineId, {
      type: "machine.connected",
      data: { runnerVersion: null },
    });
    await db
      .update(schema.machine)
      .set({ name: "renamed" })
      .where(eq(schema.machine.id, machineId));
    expect((await activity(cookie)).items[0].machine).toEqual({ id: machineId, name: "renamed" });

    await db.delete(schema.machine).where(eq(schema.machine.id, machineId));
    expect((await activity(cookie)).items[0].machine).toEqual({ id: null, name: "laptop" });
  });

  test("a machine that no longer exists logs nothing", async () => {
    const { cookie } = await workspaceWithMachine();
    await recordMachineEvent(createDb(env.DB), "no-such-machine", {
      type: "machine.connected",
      data: { runnerVersion: null },
    });
    expect((await activity(cookie)).items).toEqual([]);
  });

  test("rejects an event whose data doesn't fit its type", async () => {
    const { workspaceId } = await workspaceWithMachine();
    await expect(
      recordEvent(createDb(env.DB), {
        workspaceId,
        type: "machine.disconnected",
        data: { machineName: "laptop", reason: "gremlins" },
      } as never),
    ).rejects.toThrow();
  });

  test("filters to one kind of event", async () => {
    const { cookie, workspaceId, machineId } = await workspaceWithMachine();
    const db = createDb(env.DB);
    await recordEvent(db, {
      workspaceId,
      machineId,
      type: "machine.revoked",
      data: { machineName: "laptop" },
    });
    expect((await activity(cookie, "?filter=machine")).items).toHaveLength(1);
    expect((await activity(cookie, "?filter=job")).items).toEqual([]);
  });

  test("narrows by date, repo, result and machine on the server", async () => {
    const { cookie, workspaceId, machineId } = await workspaceWithMachine();
    const db = createDb(env.DB);
    const installationId = 5000 + ids;
    await db.insert(schema.githubInstallation).values({
      id: installationId,
      accountId: installationId,
      accountLogin: `filters-${ids}`,
      accountType: "Organization",
    });
    await testing.useInstallation(env, workspaceId, installationId);
    const job = async (id: number, repo: string, conclusion: string | null, onMachine = false) => {
      await db.insert(schema.workflowJob).values({
        id,
        installationId,
        repositoryId: 1,
        repositoryFullName: repo,
        runId: id,
        runAttempt: 1,
        kind: "job",
        name: `job ${id}`,
        labels: ["ubuntu-latest"],
        headSha: "abc",
        status: conclusion ? "completed" : "in_progress",
        conclusion,
        machineId: onMachine ? machineId : null,
        githubCreatedAt: new Date(),
      });
      await recordEvent(db, { workspaceId, jobId: id, type: "job.routed", data: {} });
    };
    const base = 880_000 + ids * 10;
    await job(base, "org/app", "success", true);
    await job(base + 1, "org/app", "failure");
    await job(base + 2, "org/site", null);
    await recordEvent(db, {
      workspaceId,
      type: "check.completed",
      data: {
        check: "Lint",
        repository: "org/site",
        repositoryId: 2,
        pullRequest: 4,
        headSha: "def",
        conclusion: "failure",
        url: null,
      },
    });
    await recordEvent(db, {
      workspaceId,
      machineId,
      type: "machine.paused",
      data: { machineName: "laptop", via: "dashboard" },
      occurredAt: new Date(Date.now() - 3 * 86_400_000),
    });

    const names = async (query: string) =>
      (await activity(cookie, query)).items.map((item) => (item.job ? item.job.name : item.type));
    expect(await names("?repository=org/site")).toEqual(["check.completed", `job ${base + 2}`]);
    expect(await names("?result=failed")).toEqual(["check.completed", `job ${base + 1}`]);
    expect(await names("?result=passed")).toEqual([`job ${base}`]);
    expect(await names("?result=running")).toEqual([`job ${base + 2}`]);
    expect(await names(`?machine=${machineId}`)).toEqual(["machine.paused", `job ${base}`]);
    expect(await names(`?since=${Date.now() - 86_400_000}&filter=machine`)).toEqual([]);
    expect(await names("?repository=org/app&result=failed")).toEqual([`job ${base + 1}`]);

    await db.insert(schema.githubRepository).values(
      ["org/site", "org/app", "org/gone"].map((fullName, index) => ({
        id: base + index,
        installationId,
        fullName,
        private: true,
        removedAt: fullName === "org/gone" ? new Date() : null,
        githubStateAt: new Date(),
      })),
    );
    // Only live, claimed machines: not a revoked enrollment or a code the CLI never claimed.
    await db.update(schema.machine).set({ os: "macos" }).where(eq(schema.machine.id, machineId));
    await db.insert(schema.machine).values([
      {
        id: `${machineId}-revoked`,
        workspaceId,
        name: "laptop",
        os: "macos",
        revokedAt: new Date(),
      },
      { id: `${machineId}-unclaimed`, workspaceId, name: "laptop" },
    ]);
    const res = await testing.call(env, "/activity/options", cookie);
    expect(await res.json()).toEqual({
      repositories: ["org/app", "org/site"],
      machines: [{ id: machineId, name: "laptop" }],
    });
  });

  test("rejects an unknown result", async () => {
    const { cookie } = await workspaceWithMachine();
    const res = await testing.call(env, "/activity?result=great", cookie);
    expect(res.status).toBe(400);
  });
});
