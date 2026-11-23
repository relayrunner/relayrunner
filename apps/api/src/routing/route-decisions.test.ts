import { relayInputs } from "@relayrunner/runner-order";
import { eq } from "drizzle-orm";
import { beforeAll, expect, test } from "vitest";
import { createDb, type Db, schema } from "../db/index.ts";
import { earlierPick, pickedLabel, pickKey, picksForJobs, recordPick } from "./route-decisions.ts";
import * as testing from "../testing.ts";

let db: Db;

beforeAll(async () => {
  const env = await testing.createTestEnv();
  db = createDb(env.DB);
  const now = Date.now();
  const statements = [
    "insert into github_installation (id, account_id, account_login, account_type, created_at, updated_at) values (8, 11, 'rerun-org', 'Organization', ?1, ?1)",
    "insert into workspace (id, installation_id, name, slug, created_at) values ('w2', 8, 'W2', 'w2', ?1)",
    // Attempt 1 picked a macOS machine; attempt 3 (a full re-run) picked another route.
    `insert into route_decision (workspace_id, repository_id, run_id, run_attempt, step, runner, skipped, not_in_order, machine, github, hosted, started_by_id, started_by_login, triggered_by_id, triggered_by_login, created_at) values ('w2', 1, 9, 1, 'machine', 'rr-0123456789ab', '[]', '[]', '["macOS"]', '["macos-latest"]', '{}', 5, 'ada', 5, 'ada', ?1)`,
    `insert into route_decision (workspace_id, repository_id, run_id, run_attempt, step, runner, skipped, not_in_order, machine, github, hosted, created_at) values ('w2', 1, 9, 3, 'machine', 'rr-ffffffffffff', '[]', '[]', '["Linux"]', '[]', '{}', ?1)`,
  ];
  for (const sql of statements) await env.DB.prepare(sql).bind(now).run();
});

test("finds the earlier attempt's pick that answered a re-run job's label", async () => {
  const pick = await earlierPick(db, {
    repositoryId: 1,
    runId: 9,
    runAttempt: 2,
    label: "rr-0123456789ab",
  });
  expect(pick).toMatchObject({
    runAttempt: 1,
    inputs: { machine: ["macOS"], github: ["macos-latest"] },
    startedBy: { id: 5, login: "ada" },
    triggeredBy: { id: 5, login: "ada" },
  });
});

test("never a label no earlier pick of the run answered", async () => {
  const key = { repositoryId: 1, runId: 9 };
  // Another run, a later attempt's pick, the job's own attempt, and a label nobody answered.
  expect(
    await earlierPick(db, { ...key, runId: 10, runAttempt: 2, label: "rr-0123456789ab" }),
  ).toBeNull();
  expect(await earlierPick(db, { ...key, runAttempt: 2, label: "rr-ffffffffffff" })).toBeNull();
  expect(await earlierPick(db, { ...key, runAttempt: 1, label: "rr-0123456789ab" })).toBeNull();
  expect(await earlierPick(db, { ...key, runAttempt: 2, label: "rr-aaaaaaaaaaaa" })).toBeNull();
});

// What a pick of repo 2's run 20 knew when it answered.
const context = (runAttempt = 1) => ({
  repo: "acme/app",
  runId: 20,
  runAttempt,
  workflow: "CI",
  workflowPath: null,
  ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
  startedBy: null,
  triggeredBy: null,
});
const routed = (runner: string, skipped: { key: "machine"; reason: string }[] = []) => ({
  runner,
  step: "machine" as const,
  skipped: skipped as never,
  notInOrder: [],
});
const pick = (pickJobId: string, decision: Parameters<typeof recordPick>[1]["decision"]) =>
  recordPick(db, {
    workspaceId: "w2",
    repositoryId: 2,
    context: context(),
    jobName: "relay",
    pickJobId,
    decision,
    reason: decision?.runner === null ? decision.reason : null,
  });

test("each pick of a run attempt keeps its own decision, and a redelivered pick keeps its first", async () => {
  await pick("relay-a", routed("rr-aaaaaaaaaaaa"));
  await pick("relay-b", routed("rr-bbbbbbbbbbbb", [{ key: "machine", reason: "machine_full" }]));
  // Redelivered: the first decision stays.
  await pick("relay-a", routed("rr-cccccccccccc"));
  // Two relays nothing fit are both kept, though neither has a runner.
  const none = { runner: null, reason: "No runner available.", skipped: [], notInOrder: [] };
  await pick("relay-c", none);
  await pick("relay-d", none);
  const rows = await db
    .select({ pickJobId: schema.routeDecision.pickJobId, runner: schema.routeDecision.runner })
    .from(schema.routeDecision)
    .where(eq(schema.routeDecision.runId, 20))
    .orderBy(schema.routeDecision.id);
  expect(rows).toEqual([
    { pickJobId: "relay-a", runner: "rr-aaaaaaaaaaaa" },
    { pickJobId: "relay-b", runner: "rr-bbbbbbbbbbbb" },
    { pickJobId: "relay-c", runner: null },
    { pickJobId: "relay-d", runner: null },
  ]);

  // A re-run of the job the second relay routed finds that relay's pick.
  const key = { repositoryId: 2, runId: 20, runAttempt: 2 };
  expect(await earlierPick(db, { ...key, label: "rr-bbbbbbbbbbbb" })).toMatchObject({
    runAttempt: 1,
    inputs: { machine: ["self-hosted"], github: ["ubuntu-latest"] },
  });
  expect(await earlierPick(db, { ...key, label: "rr-aaaaaaaaaaaa" })).not.toBeNull();

  // Each job takes the walk of the pick that answered its label; a run takes its first pick's.
  const jobs = [
    { ...key, runAttempt: 1, id: 1, labels: ["rr-aaaaaaaaaaaa"] },
    { ...key, runAttempt: 1, id: 2, labels: ["RR-BBBBBBBBBBBB"] },
    { ...key, id: 3, labels: ["rr-bbbbbbbbbbbb"] },
    { ...key, runAttempt: 1 },
  ];
  const picks = await picksForJobs(db, jobs);
  expect(jobs.map((job) => picks.get(pickKey(job))?.walk?.skipped)).toEqual([
    [],
    [{ key: "machine", reason: "machine_full" }],
    [{ key: "machine", reason: "machine_full" }],
    [],
  ]);
});

test("a label is ours when a pick of the same run answered it, in any attempt", async () => {
  const run = { repositoryId: 1, runId: 9 };
  expect(await pickedLabel(db, { ...run, label: "rr-0123456789ab" })).toBe(true);
  expect(await pickedLabel(db, { ...run, label: "rr-ffffffffffff" })).toBe(true);
  // Another run's label, or one nobody answered.
  expect(await pickedLabel(db, { ...run, runId: 10, label: "rr-0123456789ab" })).toBe(false);
  expect(await pickedLabel(db, { ...run, label: "rr-aaaaaaaaaaaa" })).toBe(false);
});
