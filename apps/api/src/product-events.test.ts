import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { recordEvent } from "./activity.ts";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { PING_WINDOW_MS } from "./operator-pings.ts";
import { collectProductEvents, sendProductEvents, type ProductEvent } from "./product-events.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

let ids = 0;

async function workspace(name: string) {
  ids += 1;
  const { cookie, user, githubId } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, name, `events-${ids}`);
  return { workspace, user, githubId };
}

async function machineArrives(
  workspaceId: string,
  machineId: string,
  type: "machine.enrolled" | "machine.connected",
  occurredAt: Date,
  userId: string | null = null,
) {
  const db = createDb(env.DB);
  await db
    .insert(schema.machine)
    .values({ id: machineId, workspaceId, userId, name: "studio", os: "macos", arch: "arm64" })
    .onConflictDoNothing();
  await recordEvent(
    db,
    type === "machine.enrolled"
      ? {
          workspaceId,
          machineId,
          type,
          data: { machineName: "studio", os: "macos", arch: "arm64" },
          occurredAt,
        }
      : {
          workspaceId,
          machineId,
          type,
          data: { machineName: "studio", runnerVersion: null },
          occurredAt,
        },
  );
}

async function routed(
  workspaceId: string,
  step: string,
  createdAt: Date,
  startedById: number | null = null,
) {
  ids += 1;
  await createDb(env.DB)
    .insert(schema.routeDecision)
    .values({
      workspaceId,
      repositoryId: 9_000 + ids,
      runId: ids,
      runAttempt: 1,
      step,
      runner: `rr-${ids}`,
      skipped: [],
      notInOrder: [],
      machine: [],
      github: [],
      startedById,
      createdAt,
    });
}

function window() {
  const until = new Date(Date.now() + 1_000);
  return { since: new Date(until.getTime() - PING_WINDOW_MS), until };
}

const forWorkspace = (events: ProductEvent[], id: string) =>
  events.filter(
    (e) =>
      (e.properties.$groups as { workspace?: string } | undefined)?.workspace === id ||
      e.properties.$group_key === id,
  );

describe("product events", () => {
  test("a signup and an App install, credited to the installer", async () => {
    const { workspace: ws, user, githubId } = await workspace("Kiln Events");
    const db = createDb(env.DB);
    const [row] = await db
      .select({ installationId: schema.workspace.installationId })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, ws.id));
    await db
      .update(schema.githubInstallation)
      .set({ installerGithubId: githubId })
      .where(eq(schema.githubInstallation.id, row!.installationId!));
    const { since, until } = window();
    const events = await collectProductEvents(db, since, until);
    const signup = events.find((e) => e.event === "signed_up" && e.distinct_id === user.id);
    expect(signup?.properties).toMatchObject({ app: "api", $set: { name: user.name } });
    const install = forWorkspace(events, ws.id);
    expect(install.map((e) => e.event)).toEqual(["$groupidentify", "github_app_installed"]);
    expect(install[0]?.properties).toMatchObject({
      $group_type: "workspace",
      $group_set: { name: "Kiln Events" },
    });
    expect(install[1]).toMatchObject({
      distinct_id: user.id,
      properties: { $groups: { workspace: ws.id }, account_type: "organization" },
    });
  });

  test("a machine's first arrival in a workspace, not its reconnects", async () => {
    const { workspace: ws, user } = await workspace("Machine Events");
    const now = Date.now();
    await machineArrives(
      ws.id,
      `ev-m-${ws.id}`,
      "machine.enrolled",
      new Date(now - 1_000),
      user.id,
    );
    await machineArrives(ws.id, `ev-m-${ws.id}`, "machine.connected", new Date(now - 500), user.id);
    const db = createDb(env.DB);
    const { since, until } = window();
    const machines = forWorkspace(await collectProductEvents(db, since, until), ws.id).filter(
      (e) => e.event === "machine_connected",
    );
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      distinct_id: user.id,
      properties: { machine_id: `ev-m-${ws.id}`, os: "macos", source: "connect" },
    });

    // A reconnect in the next window isn't an arrival.
    await machineArrives(
      ws.id,
      `ev-m-${ws.id}`,
      "machine.connected",
      new Date(until.getTime() + 1_000),
      user.id,
    );
    const later = await collectProductEvents(db, until, new Date(until.getTime() + PING_WINDOW_MS));
    expect(forWorkspace(later, ws.id).filter((e) => e.event === "machine_connected")).toEqual([]);
  });

  test("every routed job: a machine job is the person's, others the workspace's", async () => {
    const { workspace: ws, user, githubId } = await workspace("Routing Events");
    const now = Date.now();
    await routed(ws.id, "machine", new Date(now - 2_000), githubId);
    await routed(ws.id, "github", new Date(now - 1_000), githubId);
    const { since, until } = window();
    const jobs = forWorkspace(
      await collectProductEvents(createDb(env.DB), since, until),
      ws.id,
    ).filter((e) => e.event === "job_routed");
    expect(jobs.map((e) => e.properties.step)).toEqual(["machine", "github"]);
    expect(jobs[0]?.distinct_id).toBe(user.id);
    expect(jobs[0]?.properties).toMatchObject({ $groups: { workspace: ws.id } });
    expect(jobs[0]?.properties.$process_person_profile).toBeUndefined();
    expect(jobs[1]).toMatchObject({
      distinct_id: `workspace:${ws.id}`,
      properties: { $process_person_profile: false },
    });
  });

  test("a machine job goes to the machine's owner, not whoever started the run", async () => {
    const { workspace: ws, user: owner } = await workspace("Owner Events");
    const { githubId: starterGithubId } = await workspace("Starter Events");
    const db = createDb(env.DB);
    const machineId = `ev-owner-${ws.id}`;
    await db
      .insert(schema.machine)
      .values({ id: machineId, workspaceId: ws.id, userId: owner.id, name: "studio" });
    const [row] = await db
      .select({ installationId: schema.workspace.installationId })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, ws.id));
    await routed(ws.id, "machine", new Date(Date.now() - 1_000), starterGithubId);
    // routed() gave this run repository 9000 + ids and run id ids.
    await db.insert(schema.workflowJob).values({
      id: 990_000 + ids,
      installationId: row!.installationId!,
      repositoryId: 9_000 + ids,
      repositoryFullName: "acme/app",
      runId: ids,
      runAttempt: 1,
      kind: "job",
      name: "build",
      labels: ["rr-1"],
      headSha: "abc",
      status: "in_progress",
      machineId,
      githubCreatedAt: new Date(),
    });
    const { since, until } = window();
    const jobs = forWorkspace(await collectProductEvents(db, since, until), ws.id).filter(
      (e) => e.event === "job_routed",
    );
    expect(jobs.map((e) => e.distinct_id)).toEqual([owner.id]);
  });

  test("leaves out operators, their workspaces and test accounts", async () => {
    const { workspace: ws, user } = await workspace("Ours");
    await createDb(env.DB)
      .update(schema.user)
      .set({ role: "operator" })
      .where(eq(schema.user.id, user.id));
    const tester = await workspace("Test Account");
    const { since, until } = window();
    const events = await collectProductEvents(createDb(env.DB), since, until, [tester.githubId]);
    expect(events.filter((e) => e.distinct_id === user.id)).toEqual([]);
    expect(forWorkspace(events, ws.id)).toEqual([]);
    expect(events.filter((e) => e.distinct_id === tester.user.id)).toEqual([]);
    expect(forWorkspace(events, tester.workspace.id)).toEqual([]);
  });

  test("sends one batch with the token, and nothing without one", async () => {
    await workspace("Batch Events");
    const sent: { url: string; body: { api_key: string; batch: ProductEvent[] } }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const at = new Date(Date.now() + 1_000);

    expect(await sendProductEvents({ ...env, POSTHOG_TOKEN: undefined }, at, fetcher)).toBe(0);
    expect(sent).toEqual([]);

    const count = await sendProductEvents({ ...env, POSTHOG_TOKEN: "phc_test" }, at, fetcher);
    expect(count).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://us.i.posthog.com/batch/");
    expect(sent[0]?.body.api_key).toBe("phc_test");
    expect(sent[0]?.body.batch).toHaveLength(count);
  });
});
