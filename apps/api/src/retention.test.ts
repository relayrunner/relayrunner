import { beforeAll, expect, test } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { DAY_MS } from "./job-timings.ts";
import { purgeOldActivity } from "./retention.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

test("drops Activity rows past 90 days but keeps each workspace's first machine milestones", async () => {
  const { cookie: signedIn } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, signedIn, "Retention", "retention");
  const installationId = 9_100;
  const db = createDb(env.DB);
  await db.insert(schema.githubInstallation).values({
    id: installationId,
    accountId: installationId,
    accountLogin: "retention-org",
    accountType: "Organization",
  });
  await testing.useInstallation(env, workspace.id, installationId);
  const now = Date.now();
  const old = new Date(now - 100 * DAY_MS);
  const recent = new Date(now - DAY_MS);

  const job = (id: number, at: Date) => ({
    id,
    installationId,
    repositoryId: 1,
    repositoryFullName: "acme/app",
    runId: id,
    runAttempt: 1,
    kind: "job" as const,
    name: "test",
    labels: ["ubuntu-latest"],
    headSha: "abc",
    status: "completed",
    githubCreatedAt: at,
  });
  await db.insert(schema.workflowJob).values([job(1, old), job(2, recent)]);

  const event = (type: string, at: Date, jobId?: number) => ({
    workspaceId: workspace.id,
    type,
    jobId,
    data: {},
    occurredAt: at,
  });
  await db
    .insert(schema.activityEvent)
    .values([
      event("machine.enrolled", old),
      event("machine.connected", old),
      event("job.routed", old, 1),
      event("workspace.renamed", old),
      event("job.routed", recent, 2),
    ]);

  const decision = (runId: number, step: string, at: Date) => ({
    workspaceId: workspace.id,
    repositoryId: 1,
    runId,
    runAttempt: 1,
    step,
    skipped: [],
    notInOrder: [],
    machine: [],
    github: [],
    createdAt: at,
  });
  await db
    .insert(schema.routeDecision)
    .values([
      decision(1, "machine", old),
      decision(2, "machine", old),
      decision(3, "github", old),
      decision(4, "github", recent),
    ]);

  // The old job and its event, two old events and two old decisions.
  expect(await purgeOldActivity(db, now)).toBe(6);

  expect((await db.select().from(schema.workflowJob)).map((row) => row.id)).toEqual([2]);
  const events = await db.select().from(schema.activityEvent);
  expect(events.map((row) => row.type)).toEqual(["machine.enrolled", "job.routed"]);
  expect(events[1].jobId).toBe(2);
  const decisions = await db.select().from(schema.routeDecision);
  expect(decisions.map((row) => row.runId)).toEqual([1, 4]);
});
